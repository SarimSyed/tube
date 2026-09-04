import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtStreamProvider } from '../src/stream/tt.js';
import { createCaches } from '../src/services/cache.js';
import { SearchService } from '../src/services/search.js';
import type { RdGateway } from '../src/services/realdebrid.js';
import type { TorrentProvider, TorrentResult } from '../src/types.js';
// Matches the real-world case: torrent uses British "Pyjamas", IMDb/Cinemeta
// uses American "Pajamas" — must still match via bigram similarity.
const TORRENT_FILENAME =
  'The Boy in the Striped Pyjamas (2008) (1080p BluRay x265 HEVC 10bit AAC 5.1 RZeroX)';

describe('TtStreamProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches a Cinemeta tt id to a torrent in the RD cloud (1 fetch)', async () => {
    // Single stubbed fetch: the Cinemeta metadata lookup.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          meta: { id: 'tt0914798', type: 'movie', name: 'The Boy in the Striped Pajamas', year: '2008' },
        }),
        { status: 200 },
      ),
    );

    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      listTorrents: vi.fn().mockResolvedValue([
        {
          id: 'T1',
          filename: TORRENT_FILENAME,
          hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c',
          bytes: 1_700_000_000,
          status: 'downloaded',
          progress: 100,
          added: '2024-01-01',
        },
      ]),
      getTorrentInfo: vi.fn().mockResolvedValue({
        id: 'T1',
        filename: TORRENT_FILENAME,
        original_filename: TORRENT_FILENAME,
        hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c',
        bytes: 1_700_000_000,
        status: 'downloaded',
        progress: 100,
        added: '2024-01-01',
        files: [
          { id: 0, path: 'The.Boy.in.the.Striped.Pyjamas.2008.1080p.mkv', bytes: 1_700_000_000, selected: 1 },
        ],
        links: ['http://mock/stream/pyjamas.mkv'],
      }),
    } as unknown as RdGateway;

    const provider = new TtStreamProvider(rd, createCaches(3600));
    const resp = await provider.resolve('movie', 'tt0914798');

    expect(resp.streams).toHaveLength(1);
    expect(resp.streams[0].url).toBe('http://mock/stream/pyjamas.mkv');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the Cinemeta lookup
  });

  it('matches a series episode id (tt:s:e) to an episode torrent in the cloud', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ meta: { id: 'tt9999999', type: 'series', name: 'President Curtis', year: '2025' } }),
        { status: 200 },
      ),
    );

    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      listTorrents: vi.fn().mockResolvedValue([
        {
          id: 'PC6',
          filename: 'President Curtis - S01E06 - Hollow - 2160p HDR Ai Upscale -Mesc.mkv',
          hash: '1111111111111111111111111111111111111111',
          bytes: 6_000_000_000,
          status: 'downloaded',
          progress: 100,
          added: '2026-06-10',
        },
      ]),
      getTorrentInfo: vi.fn().mockResolvedValue({
        id: 'PC6',
        filename: 'President Curtis - S01E06 - Hollow - 2160p HDR Ai Upscale -Mesc.mkv',
        original_filename: 'President.Curtis.S01E06.Hollow.2160p.Mesc.mkv',
        hash: '1111111111111111111111111111111111111111',
        bytes: 6_000_000_000,
        status: 'downloaded',
        progress: 100,
        added: '2026-06-10',
        files: [{ id: 0, path: 'President.Curtis.S01E06.Hollow.2160p.Mesc.mkv', bytes: 6_000_000_000, selected: 1 }],
        links: ['http://mock/stream/president-curtis-s01e06.mkv'],
      }),
    } as unknown as RdGateway;

    const provider = new TtStreamProvider(rd, createCaches(3600));
    const resp = await provider.resolve('series', 'tt9999999:1:6');

    expect(resp.streams).toHaveLength(1);
    expect(resp.streams[0].url).toBe('http://mock/stream/president-curtis-s01e06.mkv');
  });
});

describe('TtStreamProvider index fallback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only adds candidates the index reports as cached', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ meta: { id: 'tt0133093', type: 'movie', name: 'The Matrix', year: '1999' } }),
        { status: 200 },
      ),
    );

    const cachedHash = 'a'.repeat(40);
    const uncachedHash = 'b'.repeat(40);

    const provider: TorrentProvider = {
      name: 'fake',
      search: vi.fn().mockResolvedValue([
        { infoHash: cachedHash, title: 'The Matrix', sizeBytes: 3_000_000_000, isSeries: false, raw: 'x', source: 'zilean' },
        { infoHash: uncachedHash, title: 'The Matrix', sizeBytes: 1_000_000_000, isSeries: false, raw: 'y', source: 'zilean' },
      ]),
      checkCached: vi.fn().mockResolvedValue(new Set([cachedHash])),
    };
    const searchService = new SearchService([provider], createCaches(3600));

    const addedHashes: string[] = [];
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      listTorrents: vi.fn().mockResolvedValue([]),
      addMagnet: vi.fn(async (magnet: string) => {
        const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!;
        addedHashes.push(hash);
        return { id: `id-${hash}`, uri: magnet };
      }),
      getTorrentInfo: vi
        .fn()
        .mockResolvedValueOnce({
          id: `id-${cachedHash}`, filename: 'm.mkv', status: 'waiting_files_selection', progress: 0, hash: cachedHash, bytes: 1, added: '',
        } as never)
        .mockResolvedValue({
          id: `id-${cachedHash}`, filename: 'm.mkv', status: 'downloaded', progress: 100, hash: cachedHash, bytes: 1, added: '',
          files: [{ id: 0, path: 'm.mkv', bytes: 1, selected: 1 }],
          links: ['https://mock/stream/matrix.mkv'],
        } as never),
      selectAllFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as RdGateway;

    const tt = new TtStreamProvider(rd, createCaches(3600), searchService);
    const resp = await tt.resolve('movie', 'tt0133093');

    expect(resp.streams).toHaveLength(1);
    expect(resp.streams[0].url).toBe('https://mock/stream/matrix.mkv');
    expect(addedHashes).toEqual([cachedHash]); // uncached candidate never added
  });
});

it('finds a TorBox cached release beyond the first six index results with an empty cloud', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({meta:{name:'Example Movie',year:'2020'}}))));
  try {
    const results = Array.from({ length: 8 }, (_, i) => ({ infoHash:String(i).repeat(40), title:'Example Movie', year:2020, isSeries:false, raw:'Example.Movie.2020.mkv', source:'zilean' as const }));
    const good = results[7];
    const caches = createCaches(120);
    const search = new SearchService([{ name:'test', search:async () => results }], caches);
    const rd = {
      provider:'torbox', listTorrents:async () => [], instantAvailability:async () => new Set([good.infoHash]),
      addMagnet:vi.fn(async () => ({id:'8',uri:''})),
      getTorrentInfo:async () => ({id:'8',hash:good.infoHash,status:'downloaded',files:[{id:1,path:'Example.Movie.2020.mkv',bytes:100,selected:1}],links:['https://example/landing']}),
      unrestrict:async () => ({download:'https://cdn.example/movie.mkv',filename:'Example.Movie.2020.mkv'}),
    } as unknown as RdGateway;
    const {streams} = await new TtStreamProvider(rd,caches,search).resolve('movie','tt123456');
    expect(streams).toHaveLength(1);
    expect(rd.addMagnet).toHaveBeenCalledWith(`magnet:?xt=urn:btih:${good.infoHash}`);
  } finally { vi.unstubAllGlobals(); }
});

it.each([
  ['movie', 'Example Movie Sequel', 2020, undefined, undefined],
  ['movie', 'Example Movie', 1990, undefined, undefined],
  ['series', 'Example Movie', 2020, 2, 1],
  ['series', 'Example Movie', 2020, 1, 3],
])('does not automatically download a mismatched %s candidate (%s, %s, %s, %s)', async (type, title, year, season, episode) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ meta: { name: 'Example Movie', year: '2020' } }))));
  try {
    const caches = createCaches(120);
    const search = new SearchService([{ name: 'fixture', search: async () => [{
      infoHash: 'a'.repeat(40), title, year, season, episode, isSeries: type === 'series', raw: String(title), source: 'zilean',
    }] } as unknown as TorrentProvider], caches);
    const rd = {
      provider: 'torbox', allowUncached: true, listTorrents: async () => [], instantAvailability: async () => new Set(),
      addMagnet: vi.fn(async () => ({ id: '42', uri: '' })), getTorrentInfo: async () => ({ status: 'downloading' }),
    } as unknown as RdGateway;
    await new TtStreamProvider(rd, caches, search).resolve(type as 'movie' | 'series', type === 'series' ? 'tt1234567:1:2' : 'tt1234567');
    expect(rd.addMagnet).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
