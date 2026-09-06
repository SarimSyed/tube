// Tests YtsProvider against a stubbed yts.mx JSON API, covering hash/quality/
// seeder/size/IMDb normalization and failure fallbacks. Mirrors the PirateBay
// provider contract: it must never throw for network/HTTP/parse errors.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YtsProvider } from '../src/services/yts.js';

function movieResponse(movies: unknown[]): Response {
  return new Response(JSON.stringify({ status: 'ok', data: { movies } }), { status: 200 });
}

describe('YtsProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a movie torrent with hash, quality, seeds, size and imdb id', async () => {
    fetchMock.mockResolvedValueOnce(movieResponse([
      {
        id: 1,
        imdb_code: 'tt0133093',
        title: 'The Matrix',
        title_long: 'The Matrix (1999)',
        year: 1999,
        torrents: [{
          hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
          quality: '1080p',
          seeds: 100,
          peers: 5,
          size: '2.30 GB',
          size_bytes: 2470000000,
          type: 'bluray',
        }],
      },
    ]));

    const results = await new YtsProvider().search('the matrix');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.infoHash).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(r.title).toBe('The Matrix');
    expect(r.quality).toBe('1080p');
    expect(r.seeders).toBe(100);
    expect(r.sizeBytes).toBe(2470000000);
    expect(r.imdbId).toBe('tt0133093');
    expect(r.isSeries).toBe(false);
    expect(r.source).toBe('yts');
  });

  it('skips torrents without a hash and rejects malformed imdb ids', async () => {
    fetchMock.mockResolvedValueOnce(movieResponse([
      {
        id: 2,
        imdb_code: 'not-an-imdb',
        title: 'Bad Imdb',
        torrents: [
          { hash: 'AAAA', quality: '720p', seeds: 1, size_bytes: 100 },
          { quality: '720p', seeds: 2, size_bytes: 200 }, // no hash -> skip
        ],
      },
      { id: 3, title: 'No Torrents', torrents: [] },
    ]));

    const results = await new YtsProvider().search('anything');

    expect(results).toHaveLength(1);
    expect(results[0].imdbId).toBeUndefined();
    expect(results[0].infoHash).toBe('aaaa');
  });

  it('returns empty on a non-ok status or a missing movies array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error' }), { status: 200 }));
    expect(await new YtsProvider().search('x')).toEqual([]);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200 }));
    expect(await new YtsProvider().search('x')).toEqual([]);
  });

  it('returns empty on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await expect(new YtsProvider().search('x')).resolves.toEqual([]);
  });

  it('bounds the request with an abort timeout', async () => {
    fetchMock.mockResolvedValueOnce(movieResponse([]));
    await new YtsProvider().search('x');
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init).toBeTruthy();
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
});
