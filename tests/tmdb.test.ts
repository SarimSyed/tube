// Tests TmdbClient.search title/year matching with a stubbed fetch, ensuring an
// unrelated first hit does not relabel the requested title.
import { afterEach, expect, it, vi } from 'vitest';
import { TmdbClient } from '../src/services/tmdb.js';
afterEach(()=>vi.unstubAllGlobals());
it('does not relabel a title using an unrelated TMDB first match', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({results:[{id:1,title:'Tiger & Bunny: The Rising',release_date:'2014-01-01'}]}))));
  expect(await new TmdbClient('test').search('Tiger & Bunny',undefined,'movie')).toBeNull();
});
it('chooses the matching title and year after unrelated hits', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({results:[
    {id:1,title:'Bunny',release_date:'2025-01-01'},
    {id:2,title:'Big Buck Bunny',release_date:'2008-01-01'},
  ]}))));
  expect(await new TmdbClient('test').search('Big Buck Bunny',2008,'movie')).toMatchObject({name:'Big Buck Bunny',year:2008});
});

it('bounds TMDB requests with an abort timeout', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
  vi.stubGlobal('fetch', fetchMock);
  await new TmdbClient('test').search('anything');
  const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
  expect(init).toBeTruthy();
  expect(init!.signal).toBeInstanceOf(AbortSignal);
});
