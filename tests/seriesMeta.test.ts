import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryCatalog } from '../src/catalogs/library.js';
import { SearchCatalog } from '../src/catalogs/search.js';
import { MetaService } from '../src/meta/meta.js';
import { createCaches } from '../src/services/cache.js';
import { SearchService } from '../src/services/search.js';
import { TorBoxClient } from '../src/services/torbox.js';
import type { RdGateway } from '../src/services/realdebrid.js';
import type { Meta } from '../src/stremio.js';
import type { TorrentResult } from '../src/types.js';
import { searchId } from '../src/id.js';

// Stremio core meta_item.rs Video.released is Option<DateTime<Utc>>:
// omitted/null dates deserialize, but an empty string rejects the whole MetaItem.
function expectValidEpisodeDates(meta: Meta | null) {
  expect(meta?.type).toBe('series');
  expect(meta?.videos?.length).toBeGreaterThan(0);
  const invalidDates = meta!.videos!.map(v => v.released)
    .filter(date => date != null && !Number.isFinite(Date.parse(date)));
  expect(invalidDates).toEqual([]);
}

describe('series metadata accepted by Stremio', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(
      input.includes('/torrents/mylist') ? {
        success: true,
        data: {
          id: 42, name: 'Example.S01.1080p', hash: 'a'.repeat(40), size: 100, progress: 1,
          created_at: '2026-01-01T00:00:00Z', download_state: 'uploading',
          download_finished: true, download_present: true,
          files: [{ id: 8, name: 'Example/Example.S01E01.1080p.mkv', size: 100 }],
        },
      } : { metas: [] },
    ))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns valid episode metadata when opening a TorBox cloud series', async () => {
    const catalog = new LibraryCatalog(new TorBoxClient('test-only'), new MetaService(null, createCaches(120)));
    const meta = await catalog.meta('rd:42', 'http://localhost');
    expect(meta?.videos?.[0]).toMatchObject({ id: 'rd:42:1:1', season: 1, episode: 1 });
    expectValidEpisodeDates(meta);
  });

  it('returns valid episode metadata when opening a series search card', async () => {
    const result: TorrentResult = {
      infoHash: 'a'.repeat(40), title: 'Example', isSeries: true, season: 1, episode: 1,
      raw: 'Example.S01E01.1080p.mkv', source: 'zilean',
    };
    const caches = createCaches(120);
    const search = new SearchService([{ name: 'fake', search: async () => [result] }], caches);
    const catalog = new SearchCatalog(new TorBoxClient('test-only'), search, new MetaService(null, caches), caches, false);
    const meta = await catalog.meta(searchId(result.infoHash, result), 'http://localhost');
    expect(meta?.videos?.[0]).toMatchObject({ season: 1, episode: 1 });
    expectValidEpisodeDates(meta);
  });

  it('returns valid episode metadata for a cloud download', async () => {
    const rd = { listDownloads: async () => [{
      id: '1', filename: 'Example.S01E01.mkv', generated: '2026-01-01T00:00:00Z',
    }] } as unknown as RdGateway;
    const catalog = new LibraryCatalog(rd, new MetaService(null, createCaches(120)));
    const meta = await catalog.meta('rd:dl:1', 'http://localhost');
    expect(meta?.videos?.[0]).toMatchObject({ id: 'rd:dl:1', season: 1, episode: 1 });
    expectValidEpisodeDates(meta);
  });
});

describe('series search episode discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  function catalogFor(result: TorrentResult) {
    const caches = createCaches(120);
    const search = new SearchService([{ name: 'fake', search: async () => [result] }], caches);
    const addMagnet = vi.fn();
    const rd = { addMagnet } as unknown as RdGateway;
    return {
      addMagnet,
      catalog: new SearchCatalog(rd, search, new MetaService(null, caches), caches, false),
    };
  }

  it('replaces a season-pack placeholder with episodes for the matching title when the index IMDb ID is wrong', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/meta/series/tt18345142.json') {
        return new Response(JSON.stringify({ meta: {
          id: 'tt18345142', type: 'series', name: 'Poemon',
          videos: [{ id: 'tt18345142:undefined:undefined', title: 'Unknown' }],
        } }));
      }
      if (path.startsWith('/catalog/series/top/search=')) {
        return new Response(JSON.stringify({ metas: [
          { id: 'tt0168366', type: 'series', name: 'Pokémon', releaseInfo: '1997-' },
        ] }));
      }
      if (path === '/meta/series/tt0168366.json') {
        return new Response(JSON.stringify({ meta: {
          id: 'tt0168366', type: 'series', name: 'Pokémon', releaseInfo: '1997-',
          videos: [
            { id: 'tt0168366:1:1', title: 'Pokémon, I Choose You!', season: 1, episode: 1, released: '1997-04-01T00:00:00.000Z' },
            { id: 'tt0168366:1:2', title: 'Pokémon Emergency!', season: 1, episode: 2, released: '1997-04-08T00:00:00.000Z' },
          ],
        } }));
      }
      throw new Error(`Unexpected metadata path: ${path}`);
    }));
    const pack: TorrentResult = {
      infoHash: 'a'.repeat(40), title: 'Pokemon', isSeries: true, season: 1,
      imdbId: 'tt18345142', raw: 'Pokemon.S01.COMPLETE.1080p', source: 'zilean',
    };
    const { catalog, addMagnet } = catalogFor(pack);
    const meta = await catalog.meta(searchId(pack.infoHash, pack), 'http://localhost');
    expect(meta).toMatchObject({ name: 'Pokémon', videos: [
      { id: 'tt0168366:1:1', season: 1, episode: 1 },
      { id: 'tt0168366:1:2', season: 1, episode: 2 },
    ] });
    expectValidEpisodeDates(meta);
    expect(addMagnet).not.toHaveBeenCalled();
  });

  it('preserves indexed episode IDs when external metadata is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Metadata service unavailable')));
    const episode: TorrentResult = {
      infoHash: 'b'.repeat(40), title: 'Pokemon', isSeries: true, season: 1, episode: 2,
      raw: 'Pokemon.S01E02.1080p.mkv', source: 'zilean',
    };
    const { catalog, addMagnet } = catalogFor(episode);
    const id = searchId(episode.infoHash, episode);
    const meta = await catalog.meta(id, 'http://localhost');
    expect(meta?.videos).toEqual([expect.objectContaining({ id, season: 1, episode: 2 })]);
    expectValidEpisodeDates(meta);
    expect(addMagnet).not.toHaveBeenCalled();
  });
});
