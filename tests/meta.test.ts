// Tests MetaService.preview metadata selection (TMDB/Cinemeta) with a stubbed
// global fetch. Ensures an incorrect index IMDb ID or unrelated search hit does
// not relabel the requested title.
import { afterEach, expect, it, vi } from 'vitest';
import { MetaService } from '../src/meta/meta.js';
import { createCaches } from '../src/services/cache.js';
import type { TmdbClient } from '../src/services/tmdb.js';

afterEach(() => vi.unstubAllGlobals());
it.each(['cinemeta', 'tmdb'])('does not relabel a series using an incorrect index IMDb ID (%s)', async (provider) => {
  const wrong = { name: 'Poemon', poster: 'https://example/wrong.jpg', background: null };
  const correct = { name: 'Pokémon', poster: 'https://example/correct.jpg', background: null };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('/meta/') ? { meta: wrong } : { metas: [{ ...correct, id: 'tt0168366' }] },
  ))));
  const tmdb = provider === 'tmdb' ? {
    findByIdentifier: async () => wrong, search: async () => correct,
  } as unknown as TmdbClient : null;
  const service = new MetaService(tmdb, createCaches(120));
  const meta = await service.preview({ id: 'sr:123', title: 'Pokemon', imdbId: 'tt18345142', type: 'series', baseUrl: 'http://localhost' });
  expect(meta.name).toBe('Pokémon');
  expect(meta.poster).toBe(correct.poster);
});

it('does not rename different search titles to the first Cinemeta hit', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ metas: [
    { id: 'tt12345', name: 'Example Movie', releaseInfo: '2020' },
  ] }))));
  const service = new MetaService(null, createCaches(120));
  const meta = await service.preview({ id: 'sr:123', title: 'Example Movie Documentary', year: 2021, type: 'movie', baseUrl: 'http://localhost' });
  expect(meta.name).toBe('Example Movie Documentary');
  expect(meta.releaseInfo).toBe('2021');
});

it('selects matching metadata instead of an unrelated result with the same year', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ metas: [
    { id: 'tt12345', name: 'Unrelated Movie', releaseInfo: '2020', poster: 'https://example/unrelated.jpg' },
    { id: 'tt56789', name: 'Example Movie', releaseInfo: '2020', poster: 'https://example/correct.jpg' },
  ] }))));
  const service = new MetaService(null, createCaches(120));
  const meta = await service.preview({ id: 'sr:123', title: 'Example Movie', year: 2020, type: 'movie', baseUrl: 'http://localhost' });
  expect(meta.name).toBe('Example Movie');
  expect(meta.poster).toBe('https://example/correct.jpg');
});

it('shares one in-flight seriesMeta lookup across concurrent callers', async () => {
  // Two requests for the same show arriving before anything is cached must issue
  // a single catalog search + single episode fetch, not one set per caller.
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('/catalog/')
      ? { metas: [{ id: 'tt123', name: 'Pokemon' }] }
      : { meta: { id: 'tt123', type: 'series', name: 'Pokemon', videos: [{ season: 1, episode: 1 }] } },
  )));
  vi.stubGlobal('fetch', fetchMock);
  const service = new MetaService(null, createCaches(120));
  const [a, b] = await Promise.all([service.seriesMeta('Pokemon'), service.seriesMeta('Pokemon')]);
  expect(a?.videos?.length).toBe(1);
  expect(b?.videos?.length).toBe(1);
  expect(fetchMock.mock.calls.length).toBe(2); // catalog + meta, not duplicated
});
