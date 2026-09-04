import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchCatalog } from '../src/catalogs/search.js';
import { SearchService } from '../src/services/search.js';
import { MetaService } from '../src/meta/meta.js';
import { createCaches } from '../src/services/cache.js';
import { StreamResolver } from '../src/stream/resolver.js';
import type { RdGateway } from '../src/services/realdebrid.js';
import type { TorrentResult } from '../src/types.js';

const movie = (hash: string, year = 2020): TorrentResult => ({ infoHash: hash.repeat(40), title: 'Example Movie', year, isSeries: false, raw: 'Example.Movie.mkv', source: 'zilean' });
function setup(results: TorrentResult[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const caches = createCaches(120);
  const search = new SearchService([{ name: 'fake', search: async () => results }], caches);
  const rd = { instantAvailability: async () => null } as unknown as RdGateway;
  return { caches, search, rd, catalog: new SearchCatalog(rd, search, new MetaService(null, caches), caches, false) };
}
afterEach(() => vi.unstubAllGlobals());

describe('search title cards', () => {
  it('groups movie releases before paging and preserves different release years', async () => {
    const { catalog } = setup([movie('a'), movie('b'), movie('c', 1990)]);
    const { metas } = await catalog.catalog('movie', 'Example', 'http://localhost');
    expect(metas).toHaveLength(2);
    expect(metas.map(m => m.releaseInfo)).toEqual(['2020', '1990']);
    expect(metas[0].name).toBe('Example Movie');
  });

  it('groups a series into one card with distinct episode videos', async () => {
    const results = [1, 1, 2].map((episode, i) => ({ ...movie(String(i)), isSeries: true, season: 1, episode }));
    const { catalog } = setup(results);
    const { metas } = await catalog.catalog('series', 'Example', 'http://localhost');
    expect(metas).toHaveLength(1);
    const meta = await catalog.meta(metas[0].id, 'http://localhost');
    expect(meta?.videos?.map(v => [v.season, v.episode])).toEqual([[1, 1], [1, 2]]);
  });

  it('keeps title context after cache expiry so streams can resolve another matching release', async () => {
    const good = movie('b');
    const { catalog } = setup([movie('a'), good]);
    const { metas } = await catalog.catalog('movie', 'Example', 'http://localhost');
    // Fresh caches simulate a restart, not just a longer-lived in-memory cache.
    const fresh = setup([movie('c', 1990), { ...movie('d'), title: 'Example Movie Sequel' }, good]);
    const meta = await fresh.catalog.meta(metas[0].id, 'http://localhost');
    expect(meta?.name).toBe('Example Movie');
    const rd = {
      addMagnet: vi.fn(async (magnet: string) => {
        if (!magnet.includes(good.infoHash)) throw new Error('Real-Debrid API error 451: infringing_file');
        return { id: 'good', uri: '' };
      }),
      getTorrentInfo: async () => ({ id: 'good', status: 'downloaded', files: [{ id: 1, path: 'Example.mkv', bytes: 100, selected: 1 }], links: ['https://rd.example/d/1'] }),
      unrestrict: async () => ({ download: 'https://cdn.example/example.mkv', filename: 'Example.mkv' }),
    } as unknown as RdGateway;
    const { streams } = await new StreamResolver(rd, { search: fresh.search, caches: fresh.caches }).resolve(metas[0].id);
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://cdn.example/example.mkv');
    expect(rd.addMagnet).toHaveBeenCalledTimes(2); // clicked release + same title/year only
  });
});
