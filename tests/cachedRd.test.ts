// Unit tests for CachedRealDebrid, the TTL-cached gateway wrapper. Uses a stub
// RdGateway (no HTTP) to verify accounts sharing one cache store stay isolated
// and concurrent uncached magnet submissions are de-duplicated.
import { describe, expect, it, vi } from 'vitest';
import { CachedRealDebrid } from '../src/services/cachedRd.js';
import { createCaches } from '../src/services/cache.js';
import type { RdGateway } from '../src/services/realdebrid.js';
import type { RdDownload, RdTorrent } from '../src/types.js';

function torrent(account: string, status = 'downloaded'): RdTorrent {
  return {
    id: 'torrent-1',
    filename: `${account}.mkv`,
    hash: 'a'.repeat(40),
    bytes: 1_000,
    status,
    progress: status === 'downloaded' ? 100 : 0,
    added: '2026-01-01T00:00:00Z',
    links: status === 'downloaded' ? [`https://rd.example/${account}`] : [],
  };
}

function download(account: string): RdDownload {
  return {
    id: 'download-1',
    filename: `${account}.mkv`,
    filesize: 1_000,
    link: 'https://rd.example/shared-link',
    host: 'rd.example',
    download: `https://download.example/${account}.mkv`,
    generated: '2026-01-01T00:00:00Z',
  };
}

function accountGateway(account: string): RdGateway {
  return {
    getUser: async () => ({ id: account === 'alice' ? 1 : 2, username: account }),
    listTorrents: async () => [torrent(account)],
    getTorrentInfo: async () => torrent(account),
    listDownloads: async () => [download(account)],
    addMagnet: async () => ({ id: 'torrent-1', uri: 'https://rd.example/torrents/1' }),
    selectAllFiles: async () => undefined,
    deleteTorrent: async () => undefined,
    unrestrict: async () => ({ download: download(account).download, filename: `${account}.mkv` }),
    instantAvailability: async () => new Set<string>(),
  };
}

// getTorrentInfo caches only the "downloaded" state, so a later poll re-reads
// an in-flight torrent instead of returning the stale pre-download status.
describe('CachedRealDebrid torrent polling', () => {
  it.each(['waiting_files_selection', 'downloading'])(
    'observes a completed torrent on the next poll after %s',
    async (status) => {
      const gateway = accountGateway('alice');
      let current = torrent('alice', status);
      gateway.getTorrentInfo = async () => current;
      const rd = new CachedRealDebrid(gateway, createCaches(300));

      expect((await rd.getTorrentInfo('torrent-1')).status).toBe(status);
      current = torrent('alice', 'downloaded');

      const completed = await rd.getTorrentInfo('torrent-1');
      expect(completed.status).toBe('downloaded');
      expect(completed.links).toEqual(['https://rd.example/alice']);
    },
  );
});

describe('CachedRealDebrid account isolation with shared application caches', () => {
  function accounts() {
    const caches = createCaches(300);
    return {
      alice: new CachedRealDebrid(accountGateway('alice'), caches),
      bob: new CachedRealDebrid(accountGateway('bob'), caches),
    };
  }

  it('returns the requesting account identity', async () => {
    const { alice, bob } = accounts();
    await alice.getUser();
    expect(await bob.getUser()).toEqual({ id: 2, username: 'bob' });
  });

  it('returns only the requesting account torrent list', async () => {
    const { alice, bob } = accounts();
    await alice.listTorrents();
    expect(await bob.listTorrents()).toEqual([torrent('bob')]);
  });

  it('returns the requesting account torrent details even when IDs match', async () => {
    const { alice, bob } = accounts();
    await alice.getTorrentInfo('torrent-1');
    expect(await bob.getTorrentInfo('torrent-1')).toEqual(torrent('bob'));
  });

  it('returns only the requesting account downloads', async () => {
    const { alice, bob } = accounts();
    await alice.listDownloads();
    expect(await bob.listDownloads()).toEqual([download('bob')]);
  });

  it('returns the requesting account unrestricted URL for a shared hoster link', async () => {
    const { alice, bob } = accounts();
    const link = 'https://rd.example/shared-link';
    await alice.unrestrict(link);
    expect(await bob.unrestrict(link)).toEqual({
      download: 'https://download.example/bob.mkv',
      filename: 'bob.mkv',
    });
  });
});

describe('CachedRealDebrid uncached submission safeguards', () => {
  const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
  // cacheKey: account lets two wrappers for one account share the queue namespace.
  function gateway(account: string, addMagnet: RdGateway['addMagnet']): RdGateway {
    return { ...accountGateway(account), provider: 'torbox', cacheKey: account, allowUncached: true, addMagnet };
  }

  it('shares concurrent and repeated submissions across wrappers for the same account', async () => {
    let release!: (value: { id: string; uri: string }) => void;
    const pending = new Promise<{ id: string; uri: string }>(resolve => { release = resolve; });
    const addMagnet = vi.fn(() => pending);
    const caches = createCaches(300);
    const first = new CachedRealDebrid(gateway('alice', addMagnet), caches);
    const second = new CachedRealDebrid(gateway('alice', addMagnet), caches);
    const requests = [first.addMagnet(magnet, false), second.addMagnet(magnet, false)];
    expect(addMagnet).toHaveBeenCalledTimes(1);
    release({ id: '', uri: magnet });
    expect(await Promise.all(requests)).toEqual([{ id: '', uri: magnet }, { id: '', uri: magnet }]);
    expect(await second.addMagnet(magnet, false)).toEqual({ id: '', uri: magnet });
    expect(addMagnet).toHaveBeenCalledTimes(1);
  });

  it('submits different magnets independently within one account', async () => {
    const addMagnet = vi.fn(async (uri: string) => ({ id: '', uri }));
    const rd = new CachedRealDebrid(gateway('alice', addMagnet), createCaches(300));
    const other = `magnet:?xt=urn:btih:${'b'.repeat(40)}`;
    expect(await rd.addMagnet(magnet, false)).toEqual({ id: '', uri: magnet });
    expect(await rd.addMagnet(other, false)).toEqual({ id: '', uri: other });
    expect(addMagnet).toHaveBeenCalledTimes(2);
  });

  it('evicts failed submissions so a retry can succeed', async () => {
    const addMagnet = vi.fn()
      .mockRejectedValueOnce(new Error('Temporary TorBox outage'))
      .mockResolvedValueOnce({ id: '42', uri: magnet });
    const rd = new CachedRealDebrid(gateway('alice', addMagnet), createCaches(300));
    await expect(rd.addMagnet(magnet, false)).rejects.toThrow('Temporary TorBox outage');
    expect(await rd.addMagnet(magnet, false)).toEqual({ id: '42', uri: magnet });
    expect(addMagnet).toHaveBeenCalledTimes(2);
  });

  it('does not share queued submission results between accounts', async () => {
    const caches = createCaches(300);
    const aliceAdd = vi.fn(async () => ({ id: 'alice-42', uri: magnet }));
    const bobAdd = vi.fn(async () => ({ id: 'bob-43', uri: magnet }));
    const alice = new CachedRealDebrid(gateway('alice', aliceAdd), caches);
    const bob = new CachedRealDebrid(gateway('bob', bobAdd), caches);
    expect(await alice.addMagnet(magnet, false)).toEqual({ id: 'alice-42', uri: magnet });
    expect(await bob.addMagnet(magnet, false)).toEqual({ id: 'bob-43', uri: magnet });
    expect(aliceAdd).toHaveBeenCalledTimes(1);
    expect(bobAdd).toHaveBeenCalledTimes(1);
  });
});

describe('CachedRealDebrid instant-availability caching', () => {
  // Gateway with a deterministic cacheKey (as real clients carry) and a
  // countable instantAvailability implementation.
  function gw(instantAvailability: RdGateway['instantAvailability']): RdGateway {
    return { ...accountGateway('alice'), cacheKey: 'alice', instantAvailability };
  }

  it('serves a repeated identical check from cache without re-querying the provider', async () => {
    const underlying = vi.fn(async () => new Set(['aaaa', 'bbbb']));
    const rd = new CachedRealDebrid(gw(underlying), createCaches(300));
    const hashes = ['aaaa', 'bbbb'];
    await rd.instantAvailability(hashes);
    await rd.instantAvailability(hashes);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('is insensitive to the order of the same hash set', async () => {
    const underlying = vi.fn(async () => new Set(['aaaa', 'bbbb']));
    const rd = new CachedRealDebrid(gw(underlying), createCaches(300));
    await rd.instantAvailability(['aaaa', 'bbbb']);
    await rd.instantAvailability(['bbbb', 'aaaa']);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('caches each account separately', async () => {
    const underlying = vi.fn(async () => new Set(['aaaa']));
    const caches = createCaches(300);
    const alice = new CachedRealDebrid(gw(underlying), caches);
    const bob = new CachedRealDebrid({ ...gw(underlying), cacheKey: 'bob' }, caches);
    await alice.instantAvailability(['aaaa']);
    await bob.instantAvailability(['aaaa']);
    expect(underlying).toHaveBeenCalledTimes(2);
  });
});
