import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TorBoxClient } from '../src/services/torbox.js';
import { StreamResolver } from '../src/stream/resolver.js';

// Wire fields verified against TorBox-App/torbox-sdk-js src/services/torrents/models.
const token = 'test-torbox-secret';
const hash = 'a'.repeat(40);
function torrent(overrides = {}) {
  return {
    id: 42, name: 'Example.S01', hash, size: 301, progress: 1,
    created_at: '2026-01-01T00:00:00Z', download_state: 'uploading',
    download_finished: true, download_present: true,
    files: [
      { id: 3, name: 'Example/subs.srt', short_name: 'subs.srt', size: 1 },
      { id: 8, name: 'Example/Example.S01E01.1080p.mkv', short_name: 'Example.S01E01.1080p.mkv', size: 100 },
      { id: 19, name: 'Example/Example.S01E02.1080p.mkv', short_name: 'Example.S01E02.1080p.mkv', size: 200 },
    ], ...overrides,
  };
}
function response(data: unknown, status = 200, success = true, error: string | null = null) {
  return new Response(JSON.stringify({ success, error, detail: 'Request result', data }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

describe('TorBoxClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('allows an explicit uncached add only for an opted-in client', async () => {
    fetchMock.mockImplementation(async () => response({ torrent_id: 42 }));
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    await new TorBoxClient(token, undefined, true).addMagnet(magnet, false);
    expect(fetchMock.mock.calls[0][1].body.get('add_only_if_cached')).toBe('false');
    await new TorBoxClient(token).addMagnet(magnet, false);
    expect(fetchMock.mock.calls[1][1].body.get('add_only_if_cached')).toBe('true');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe(`Bearer ${token}`);
  });

  it('maps a finished present torrent into the common library shape', async () => {
    fetchMock.mockResolvedValueOnce(response([torrent()]));
    expect(await new TorBoxClient(token).listTorrents()).toEqual([
      expect.objectContaining({ id: '42', filename: 'Example.S01', hash, bytes: 301, status: 'downloaded', progress: 100 }),
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/api/torrents/mylist');
    expect(new URL(url).searchParams.get('bypass_cache')).toBe('true');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
  });

  it.each([[false, false], [true, false], [false, true]])(
    'does not treat download_state=completed as playable with finished=%s present=%s',
    async (download_finished, download_present) => {
      fetchMock.mockResolvedValueOnce(response([torrent({ download_finished, download_present, download_state: 'completed' })]));
      expect((await new TorBoxClient(token).listTorrents())[0].status).not.toBe('downloaded');
    },
  );

  it('refreshes torrent details using mylist id and bypass_cache', async () => {
    fetchMock.mockResolvedValueOnce(response(torrent()));
    const info = await new TorBoxClient(token).getTorrentInfo('42');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1/api/torrents/mylist');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ id: '42', bypass_cache: 'true' });
    expect(info.files?.[2]).toMatchObject({ id: 19, path: 'Example/Example.S01E02.1080p.mkv', bytes: 200, selected: 1 });
  });

  it('adds a multipart magnet and returns the actual torrent ID', async () => {
    fetchMock.mockResolvedValueOnce(response({ torrent_id: 42, hash, auth_id: 'account-id' }));
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    expect(await new TorBoxClient(token).addMagnet(magnet)).toMatchObject({ id: '42' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/api/torrents/createtorrent');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('magnet')).toBe(magnet);
  });

  it('checks hashes in bounded batches and merges only cache hits', async () => {
    const hashes = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(40, '0'));
    fetchMock.mockImplementation(async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toBe('/v1/api/torrents/checkcached');
      const batch = url.searchParams.getAll('hash').flatMap((h) => h.split(','));
      expect(batch.length).toBeLessThanOrEqual(100);
      const hit = batch.filter((h) => h === hashes[0] || h === hashes[100]);
      const rows = hit.map((h) => ({ hash: h, name: 'Example', size: 100 }));
      return response(url.searchParams.get('format') === 'list' ? rows : Object.fromEntries(rows.map((r) => [r.hash, r])));
    });
    expect(await new TorBoxClient(token).instantAvailability(hashes)).toEqual(new Set([hashes[0], hashes[100]]));
  });

  it('resolves the exact episode file to a direct CDN URL through the library resolver', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/mylist')) return response(torrent());
      expect(url.pathname).toBe('/v1/api/torrents/requestdl');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        token, torrent_id: '42', file_id: '19', redirect: 'false',
      });
      return response('https://cdn.example/episode-two.mkv');
    });
    const { streams } = await new StreamResolver(new TorBoxClient(token)).resolve('rd:42:1:2');
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      url: 'https://cdn.example/episode-two.mkv',
      behaviorHints: { filename: 'Example.S01E02.1080p.mkv', videoSize: 200 },
    });
    expect(JSON.stringify(streams)).not.toContain(token);
  });

  it.each([401, 429])('preserves HTTP %s without leaking response details or credentials', async (status) => {
    fetchMock.mockResolvedValueOnce(response(null, status, false, `Failed token ${token}`));
    const error = await new TorBoxClient(token).listTorrents().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status });
    expect(String(error)).not.toContain(token);
  });

  it('rejects semantic API failures even when HTTP is 200', async () => {
    fetchMock.mockResolvedValueOnce(response(null, 200, false, 'ACTIVE_LIMIT'));
    await expect(new TorBoxClient(token).addMagnet(`magnet:?xt=urn:btih:${hash}`)).rejects.toThrow();
  });

  it('accepts a successful uncached submission with no active torrent ID yet', async () => {
    fetchMock.mockResolvedValueOnce(response(null));
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const client = new TorBoxClient(token, undefined, true);
    expect(await client.addMagnet(magnet, false)).toEqual({ id: '', uri: magnet });
    expect(fetchMock.mock.calls[0][1].body.get('add_only_if_cached')).toBe('false');
  });
});

it('labels TorBox streams without calling them Real-Debrid', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => response(input.includes('/mylist') ? torrent() : 'https://cdn.example/movie.mkv')));
  try {
    const { streams } = await new StreamResolver(new TorBoxClient(token)).resolve('rd:42:1:1');
    expect(streams[0].name).toBe('TB 1080P ⚡');
    expect(streams[0].behaviorHints?.bingeGroup).toBe('tube-tb');
  } finally { vi.unstubAllGlobals(); }
});

it('asks TorBox to add only cached torrents to avoid queueing an unexpected download', async () => {
  const fetchMock=vi.fn().mockResolvedValue(response({torrent_id:42}));
  vi.stubGlobal('fetch',fetchMock);
  try {
    await new TorBoxClient(token).addMagnet(`magnet:?xt=urn:btih:${hash}`);
    expect(fetchMock.mock.calls[0][1].body.get('add_only_if_cached')).toBe('true');
  } finally { vi.unstubAllGlobals(); }
});
