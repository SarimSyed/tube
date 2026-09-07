// Tests SearchService relevance ranking and title filtering (rankByRelevance plus
// token coverage) with fake providers and no HTTP.
import { describe, it, expect, vi } from 'vitest';
import { SearchService, rankByRelevance } from '../src/services/search.js';
import { createCaches } from '../src/services/cache.js';
import type { TorrentProvider, TorrentResult } from '../src/types.js';

function r(title: string): TorrentResult {
  return { infoHash: title.replace(/\W/g, '').slice(0, 40).toLowerCase(), title, isSeries: false, raw: title, source: 'zilean' };
}

describe('rankByRelevance', () => {
  it('ranks the exact-title match above a partial "…strikes back" match', () => {
    const mewtwo = r('Pokemon Mewtwo Strikes Back Evolution');
    const empire = r('The Empire Strikes Back');
    const ranked = [mewtwo, empire].sort((a, b) => rankByRelevance(b, 'empire strikes back') - rankByRelevance(a, 'empire strikes back'));
    expect(ranked[0].title).toBe('The Empire Strikes Back');
  });
});

describe('SearchService.search relevance', () => {
  it('returns provider results re-ranked by query relevance', async () => {
    const provider: TorrentProvider = {
      name: 'fake',
      search: vi.fn().mockResolvedValue([
        r('Pokemon Mewtwo Strikes Back Evolution'),
        r('The Empire Strikes Back'),
      ]),
    };
    const svc = new SearchService([provider], createCaches(3600));
    const results = await svc.search('empire strikes back', 'movie');
    expect(results[0].title).toBe('The Empire Strikes Back');
  });
});

it('excludes loose index matches that do not cover the requested title', async () => {
  const provider: TorrentProvider = { name:'fake', search:async () => [r('Big'),r('Bunny'),r('Big Buck Bunny')] };
  const results=await new SearchService([provider],createCaches(120)).search('Big Buck Bunny','movie');
  expect(results.map(r=>r.title)).toEqual(['Big Buck Bunny']);
});

describe('SearchService result caching', () => {
  it('re-queries the providers when the first attempt returned nothing', async () => {
    // A transient outage must not leave an empty result pinned in the cache.
    const provider: TorrentProvider = { name: 'fake', search: vi.fn().mockResolvedValue([]) };
    const svc = new SearchService([provider], createCaches(3600));
    await svc.search('something', 'movie');
    await svc.search('something', 'movie');
    expect(provider.search).toHaveBeenCalledTimes(2);
  });

  it('caches a non-empty result across identical queries', async () => {
    const provider: TorrentProvider = { name: 'fake', search: vi.fn().mockResolvedValue([r('The Matrix')]) };
    const svc = new SearchService([provider], createCaches(3600));
    await svc.search('the matrix', 'movie');
    await svc.search('the matrix', 'movie');
    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical queries into a single provider call', async () => {
    // Two requests that arrive together (before any result is cached) must share
    // one provider fan-out instead of running two identical searches.
    const provider: TorrentProvider = { name: 'fake', search: vi.fn().mockResolvedValue([r('The Matrix')]) };
    const svc = new SearchService([provider], createCaches(3600));
    const [a, b] = await Promise.all([
      svc.search('the matrix', 'movie'),
      svc.search('the matrix', 'movie'),
    ]);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(a[0].title).toBe('The Matrix');
    expect(b[0].title).toBe('The Matrix');
  });

  it('excludes adult releases even when they match the query title', async () => {
    const plain = r('Obsession');
    const provider: TorrentProvider = {
      name: 'fake',
      search: vi.fn().mockResolvedValue([
        plain,
        { ...r('b'), category: '507' }, // adult index category
        { ...r('c'), raw: 'Obsession.2017.Brazzers.mkv' }, // studio marker
      ]),
    };
    const svc = new SearchService([provider], createCaches(3600));
    const results = await svc.search('obsession', 'movie');
    expect(results.map((x) => x.infoHash)).toEqual([plain.infoHash]);
  });
});
