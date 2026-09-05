// Tests ZileanProvider (DMM search + checkcached) with a stubbed fetch, covering
// result normalization, the X-API-Key header, and failure fallbacks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZileanProvider } from '../src/services/zilean.js';

describe('ZileanProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a movie and a series result', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            raw_title: 'The.Matrix.1999.2160p.BluRay.x265-GROUP',
            cleaned_parsed_title: 'The Matrix',
            year: 1999,
            resolution: '2160p',
            category: 'movie',
            imdb_id: 'tt0133093',
            info_hash: 'ABCDEF0123456789',
            size: '12.3 GB',
          },
          {
            raw_title: 'Breaking.Bad.S01E01.1080p.WEB-DL',
            cleaned_parsed_title: 'Breaking Bad',
            category: 'tv',
            seasons: [1],
            episodes: [1],
            info_hash: 'FEDCBA9876543210',
          },
        ]),
        { status: 200 },
      ),
    );

    const provider = new ZileanProvider('https://zilean.example');
    const results = await provider.search('matrix');

    expect(fetchMock.mock.calls[0][0]).toBe('https://zilean.example/dmm/search');
    expect(results).toHaveLength(2);

    const movie = results[0];
    expect(movie.infoHash).toBe('abcdef0123456789');
    expect(movie.isSeries).toBe(false);
    expect(movie.quality).toBe('2160p');
    expect(movie.year).toBe(1999);
    expect(movie.imdbId).toBe('tt0133093');

    const series = results[1];
    expect(series.isSeries).toBe(true);
    expect(series.season).toBe(1);
    expect(series.episode).toBe(1);
  });

  it('returns empty when the endpoint fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    const provider = new ZileanProvider('https://zilean.example');
    await expect(provider.search('x')).resolves.toEqual([]);
  });

  it('checkCached returns the cached hashes and sends the API key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { info_hash: 'ABCDEF0123456789', is_cached: true },
          { info_hash: '9999999999999999', is_cached: false },
        ]),
        { status: 200 },
      ),
    );
    const provider = new ZileanProvider('https://zilean.example', 'secret-key');
    const cached = await provider.checkCached(['ABCDEF0123456789', '9999999999999999']);
    expect([...cached]).toEqual(['abcdef0123456789']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/torrents/checkcached?hashes=');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key');
  });

  it('checkCached returns empty when no API key is configured', async () => {
    const provider = new ZileanProvider('https://zilean.example');
    await expect(provider.checkCached(['abc'])).resolves.toEqual(new Set());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
