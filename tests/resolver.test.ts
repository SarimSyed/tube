// Tests StreamResolver, which turns rd:/sr: ids into playable Stremio streams.
// Uses stub RdGateway objects to cover library torrents, search-hash probing,
// unrestricted-URL validation, and TorBox cache hits.
import { describe, it, expect, vi } from 'vitest';
import { StreamResolver } from '../src/stream/resolver.js';
import { SearchService } from '../src/services/search.js';
import { createCaches } from '../src/services/cache.js';
import type { RealDebridClient } from '../src/services/realdebrid.js';
import type { TorrentProvider } from '../src/types.js';
import { NegativeStore } from '../src/services/negativeStore.js';

function downloadedTorrent(): Record<string, unknown> {
  return {
    id: 'T1',
    filename: 'The Matrix 1999 1080p.mkv',
    original_filename: 'The.Matrix.1999.1080p.BluRay.x265-GECKOS.mkv',
    hash: 'h1',
    bytes: 100,
    status: 'downloaded',
    progress: 100,
    added: '2024-01-01',
    files: [
      { id: 0, path: 'The.Matrix.1999.1080p.mkv', bytes: 100, selected: 1 },
      { id: 1, path: 'subs.srt', bytes: 1, selected: 0 },
    ],
    links: ['https://rd.example/d/1/The.Matrix.1999.1080p.mkv'],
  };
}

describe('StreamResolver', () => {
  it('resolves a downloaded library torrent to RD streams', async () => {
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      getTorrentInfo: vi.fn().mockResolvedValue(downloadedTorrent()),
      listDownloads: vi.fn().mockResolvedValue([]),
    } as unknown as RealDebridClient;

    const resolver = new StreamResolver(rd);
    const resp = await resolver.resolve('rd:T1');
    expect(resp.streams.length).toBe(1);
    expect(resp.streams[0].url).toBe('https://rd.example/d/1/The.Matrix.1999.1080p.mkv');
    expect(resp.streams[0].name).toBe('RD 1080P ⚡');
  });

  it('returns empty streams when torrent is still downloading', async () => {
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      getTorrentInfo: vi.fn().mockResolvedValue({ ...downloadedTorrent(), status: 'downloading', links: [] }),
      listDownloads: vi.fn().mockResolvedValue([]),
    } as unknown as RealDebridClient;

    const resolver = new StreamResolver(rd);
    const resp = await resolver.resolve('rd:T1');
    expect(resp.streams).toEqual([]);
  });

  it('resolves a search hash by adding a magnet and selecting files', async () => {
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      addMagnet: vi.fn().mockResolvedValue({ id: 'T2', uri: 'magnet:?xt=urn:btih:aaaa' }),
      getTorrentInfo: vi
        .fn()
        .mockResolvedValueOnce({ ...downloadedTorrent(), status: 'waiting_files_selection' })
        .mockResolvedValue(downloadedTorrent()),
      selectAllFiles: vi.fn().mockResolvedValue(undefined),
      listDownloads: vi.fn().mockResolvedValue([]),
    } as unknown as RealDebridClient;

    const resolver = new StreamResolver(rd);
    const resp = await resolver.resolve('sr:aaaa');
    expect(rd.addMagnet).toHaveBeenCalledWith('magnet:?xt=urn:btih:aaaa');
    expect(rd.selectAllFiles).toHaveBeenCalled();
    expect(resp.streams.length).toBe(1);
  });

  it('returns empty streams (no crash) when RD blocks the magnet (infringing_file)', async () => {
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      addMagnet: vi.fn().mockRejectedValue(new Error('Real-Debrid API error 451: infringing_file')),
      getTorrentInfo: vi.fn(),
      selectAllFiles: vi.fn(),
      listDownloads: vi.fn().mockResolvedValue([]),
    } as unknown as RealDebridClient;

    const resolver = new StreamResolver(rd);
    const resp = await resolver.resolve('sr:aaaa');
    expect(resp.streams).toEqual([]);
  });
});

describe('StreamResolver search-result fallback', () => {
  it('does not retry a known blocked legacy search ID', async () => {
    const negatives = new NegativeStore('/tmp/tube-unused-negative-test.json');
    negatives.get().add('aaaa');
    const rd = { addMagnet: vi.fn().mockRejectedValue(new Error('infringing_file')) } as unknown as RealDebridClient;
    expect((await new StreamResolver(rd, { negatives }).resolve('sr:aaaa')).streams).toEqual([]);
    expect(rd.addMagnet).not.toHaveBeenCalled();
  });

  it('probes other cached copies when the clicked hash is blocked', async () => {
    const blockedHash = 'a'.repeat(40);
    const goodHash = 'b'.repeat(40);
    const provider: TorrentProvider = {
      name: 'fake',
      search: vi.fn().mockResolvedValue([
        { infoHash: blockedHash, title: 'Pokemon', isSeries: false, raw: 'x', source: 'zilean' },
        { infoHash: goodHash, title: 'Pokemon', sizeBytes: 2_000_000_000, isSeries: false, raw: 'y', source: 'zilean' },
      ]),
      checkCached: vi.fn().mockResolvedValue(new Set([goodHash])),
    };
    const caches = createCaches(3600);
    caches.search.set(`result:${blockedHash}`, {
      infoHash: blockedHash, title: 'Pokemon', isSeries: false, raw: 'x', source: 'zilean',
    });

    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      addMagnet: vi.fn(async (magnet: string) => {
        const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!;
        if (hash === blockedHash) throw new Error('Real-Debrid API error 451: infringing_file');
        return { id: `id-${hash}`, uri: magnet };
      }),
      getTorrentInfo: vi
        .fn()
        .mockResolvedValueOnce({
          id: `id-${goodHash}`, filename: 'p.mkv', status: 'waiting_files_selection', progress: 0, hash: goodHash, bytes: 1, added: '',
        } as never)
        .mockResolvedValue({
          id: `id-${goodHash}`, filename: 'p.mkv', status: 'downloaded', progress: 100, hash: goodHash, bytes: 1, added: '',
          files: [{ id: 0, path: 'p.mkv', bytes: 1, selected: 1 }],
          links: ['https://mock/stream/pokemon.mkv'],
        } as never),
      selectAllFiles: vi.fn().mockResolvedValue(undefined),
      deleteTorrent: vi.fn().mockResolvedValue(undefined),
    } as unknown as RealDebridClient;

    const resolver = new StreamResolver(rd, {
      search: new SearchService([provider], caches),
      caches,
    });

    const resp = await resolver.resolve(`sr:${blockedHash}`);
    expect(resp.streams).toHaveLength(1);
    expect(resp.streams[0].url).toBe('https://mock/stream/pokemon.mkv');
    // Only the checkcached-approved hash was ever added.
    const added = rd.addMagnet.mock.calls.map((c) => (c[0] as string).match(/btih:([0-9a-f]+)/i)?.[1]);
    expect(added).toEqual([goodHash]);
  });
});

describe('StreamResolver direct URLs', () => {
  it.each(['realdebrid', 'torbox'])('emits one description field for Stremio (%s)', async (provider) => {
    const rd = {
      provider,
      getTorrentInfo: vi.fn().mockResolvedValue(downloadedTorrent()),
      unrestrict: vi.fn().mockResolvedValue({ download: 'https://cdn.example/movie.mkv', filename: 'Movie.mkv' }),
      listDownloads: async () => [{ id: 'd1', download: 'https://cdn.example/movie.mp4', filename: 'Movie.mp4', filesize: 100 }],
    } as unknown as RealDebridClient;
    for (const id of ['rd:T1', 'rd:dl:d1']) {
      const response = JSON.parse(JSON.stringify(await new StreamResolver(rd).resolve(id)));
      expect(response.streams).toHaveLength(1);
      // Stremio aliases title to description; sending both fails deserialization.
      expect(response.streams[0]).not.toHaveProperty('title');
      expect(response.streams[0].description).toMatch(/^Movie\.(mkv|mp4)\n100 B$/);
    }
  });

  it('does not advertise an HTML landing page when unrestrict fails', async () => {
    const rd = {
      getTorrentInfo: vi.fn().mockResolvedValue(downloadedTorrent()),
      unrestrict: vi.fn().mockRejectedValue(new Error('Real-Debrid API error 451: infringing_file')),
    } as unknown as RealDebridClient;
    expect((await new StreamResolver(rd).resolve('rd:T1')).streams).toEqual([]);
  });

  it('marks MKV streams as needing the Stremio streaming server', async () => {
    const rd = {
      getTorrentInfo: vi.fn().mockResolvedValue(downloadedTorrent()),
      unrestrict: vi.fn().mockResolvedValue({ download: 'https://cdn.example/movie.mkv', filename: 'Movie.mkv' }),
    } as unknown as RealDebridClient;
    const { streams } = await new StreamResolver(rd).resolve('rd:T1');
    expect(streams[0].behaviorHints).toMatchObject({ notWebReady: true, filename: 'Movie.mkv', videoSize: 100 });
  });

  it('returns no streams for an episode missing from the torrent', async () => {
    const rd = {
      getTorrentInfo: vi.fn().mockResolvedValue(downloadedTorrent()),
      unrestrict: vi.fn().mockResolvedValue({ download: 'https://cdn.example/movie.mkv', filename: 'Movie.mkv' }),
    } as unknown as RealDebridClient;
    expect((await new StreamResolver(rd).resolve('rd:T1:1:2')).streams).toEqual([]);
  });

  it('returns the unrestricted download URL, not the links[] landing page', async () => {
    const rd = {
      getTorrentInfo: vi.fn().mockResolvedValue({
        id: 'T1',
        filename: 'm.mkv',
        original_filename: 'Movie.2020.1080p.mkv',
        hash: 'h1',
        bytes: 100,
        status: 'downloaded',
        progress: 100,
        added: '2024-01-01',
        files: [{ id: 0, path: 'Movie.2020.1080p.mkv', bytes: 100, selected: 1 }],
        links: ['https://real-debrid.com/d/PAGELINK'],
      }),
      listDownloads: vi.fn().mockResolvedValue([]),
      unrestrict: vi.fn().mockResolvedValue({
        download: 'https://dl.example.com/file.mkv',
        filename: 'Movie.2020.1080p.mkv',
      }),
    } as unknown as RealDebridClient;

    const resolver = new StreamResolver(rd);
    const resp = await resolver.resolve('rd:T1');
    expect(resp.streams[0].url).toBe('https://dl.example.com/file.mkv');
    expect(rd.unrestrict).toHaveBeenCalledWith('https://real-debrid.com/d/PAGELINK');
  });
});

it.each(['', 'not-a-url', 'javascript:alert(1)'])('omits invalid unrestricted URLs: %s', async (download) => {
  const rd = {
    getTorrentInfo: vi.fn().mockResolvedValue(downloadedTorrent()),
    unrestrict: vi.fn().mockResolvedValue({ download, filename: 'movie.mkv' }),
  } as unknown as RealDebridClient;
  expect((await new StreamResolver(rd).resolve('rd:T1')).streams).toEqual([]);
});

it.each([
  ['https://cdn.example/movie.mp4', 'movie.mp4', false],
  ['http://cdn.example/movie.mp4', 'movie.mp4', true],
  ['https://cdn.example/movie.mkv', 'movie.mkv', true],
])('sets download playback hints for %s', async (download, filename, notWebReady) => {
  const rd = { listDownloads: async () => [{ id: 'd1', download, filename, filesize: 100 }] } as unknown as RealDebridClient;
  const { streams } = await new StreamResolver(rd).resolve('rd:dl:d1');
  expect(streams[0].behaviorHints).toMatchObject({ notWebReady, filename, videoSize: 100 });
});

it('uses TorBox cache hits even when the search index reports different RD cached hashes', async () => {
  const cached = 'b'.repeat(40);
  const notCached = 'a'.repeat(40);
  const results = [notCached, cached].map(infoHash => ({ infoHash, title: 'Example', isSeries: false, raw: 'Example.mkv', source: 'zilean' as const }));
  const caches = createCaches(120);
  caches.search.set(`result:${notCached}`, results[0]);
  const rd = {
    provider: 'torbox',
    instantAvailability: async () => new Set([cached]),
    addMagnet: vi.fn(async () => ({ id: 'T1', uri: '' })),
    getTorrentInfo: async () => downloadedTorrent(),
    unrestrict: async () => ({ download: 'https://cdn.example/movie.mkv', filename: 'Example.mkv' }),
  } as unknown as RealDebridClient;
  const search = new SearchService([{ name: 'fake', search: async () => results, checkCached: async () => new Set([notCached]) }], caches);
  const { streams } = await new StreamResolver(rd, { search, caches }).resolve(`sr:${notCached}`);
  expect(streams).toHaveLength(1);
  expect(rd.addMagnet).toHaveBeenCalledWith(`magnet:?xt=urn:btih:${cached}`);
  expect(rd.addMagnet).toHaveBeenCalledTimes(1);
});
