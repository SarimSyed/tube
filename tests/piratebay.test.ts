// Tests PirateBayProvider against stubbed apibay.org JSON, checking hash/seeder/
// size/IMDb normalization and TV-category series detection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PirateBayProvider } from '../src/services/piratebay.js';

describe('PirateBayProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a movie result with seeders, size and imdb id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            name: 'Avatar.The.Legend.of.Aang.The.Last.Airbender.2026.1080p.WEBRip.x264.mp4',
            info_hash: '5E0FB5D079F91918ABF0A36389B1448BE299F55E',
            leechers: '998',
            seeders: '2407',
            size: '3406311653',
            imdb: 'tt18259538',
            category: '207',
          },
        ]),
        { status: 200 },
      ),
    );

    const provider = new PirateBayProvider();
    const results = await provider.search('avatar the last airbender');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.infoHash).toBe('5e0fb5d079f91918abf0a36389b1448be299f55e');
    expect(r.seeders).toBe(2407);
    expect(r.sizeBytes).toBe(3406311653);
    expect(r.imdbId).toBe('tt18259538');
    expect(r.isSeries).toBe(false);
    expect(r.source).toBe('piratebay');
    expect(r.title.length).toBeGreaterThan(0);
  });

  it('classifies TV category results as series and skips malformed entries', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { name: 'Show.S01E01.720p.mkv', info_hash: 'ABCDEF', seeders: '10', size: '100', category: '208' },
          { name: 'no-hash-here', seeders: '5', size: '1', category: '205' },
        ]),
        { status: 200 },
      ),
    );

    const provider = new PirateBayProvider();
    const results = await provider.search('show');

    expect(results).toHaveLength(1);
    expect(results[0].isSeries).toBe(true);
    expect(results[0].seeders).toBe(10);
  });

  it('bounds the request with an abort timeout so a hung upstream cannot stall the handler', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ name: 'x.2020.mkv', info_hash: 'ABCDEF', seeders: '1' }]), { status: 200 }),
    );
    await new PirateBayProvider().search('x');
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init).toBeTruthy();
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
});
