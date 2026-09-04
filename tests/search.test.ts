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
