import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { findCachedStreams } from '../src/stream/cacheProbe.js';
import type { RdGateway } from '../src/services/realdebrid.js';
import type { TorrentResult } from '../src/types.js';

function result(hash: string, size = 1_000_000_000): TorrentResult {
  return {
    infoHash: hash,
    title: 'Some Title',
    sizeBytes: size,
    isSeries: false,
    raw: 'raw',
    source: 'zilean',
  };
}

/**
 * Fake RD where a hash is "cached" if RD reports it `downloaded` quickly after
 * file selection, and "uncached" if it stays `downloading` forever.
 */
function fakeRd(cached: Set<string>) {
  const statusByHash = new Map<string, number>(); // id -> calls
  const calls: { deleteId: string | null; addedHashes: string[] } = {
    deleteId: null,
    addedHashes: [],
  };

  const rd = {
    listTorrents: async () => [],
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
    addMagnet: vi.fn(async (magnet: string) => {
      const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!.toLowerCase();
      calls.addedHashes.push(hash);
      return { id: `id-${hash}`, uri: magnet };
    }),
    getTorrentInfo: vi.fn(async (id: string) => {
      const hash = id.replace(/^id-/, '');
      statusByHash.set(hash, (statusByHash.get(hash) ?? 0) + 1);
      const call = statusByHash.get(hash)!;
      const isCached = cached.has(hash);
      if (call === 1) {
        return { id, filename: 'movie.mkv', status: 'waiting_files_selection', progress: 0, hash, bytes: 1, added: '' } as never;
      }
      if (isCached) {
        return {
          id,
          filename: 'movie.mkv',
          status: 'downloaded',
          progress: 100,
          hash,
          bytes: 1,
          added: '',
          files: [{ id: 0, path: 'movie.mkv', bytes: 1, selected: 1 }],
          links: [`https://mock/stream/${hash}.mkv`],
        } as never;
      }
      return { id, filename: 'movie.mkv', status: 'downloading', progress: 10, hash, bytes: 1, added: '' } as never;
    }),
    selectAllFiles: vi.fn(async () => undefined),
    deleteTorrent: vi.fn(async (id: string) => {
      calls.deleteId = id;
    }),
  } as unknown as RdGateway;

  return { rd, calls };
}

describe('findCachedStreams', () => {
  it('returns streams from the first cached candidate', async () => {
    const { rd, calls } = fakeRd(new Set(['aaa'.repeat(10)]));
    const streams = await findCachedStreams(rd, [result('aaa'.repeat(10))], { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://mock/stream/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mkv');
    expect(calls.deleteId).toBeNull();
  });

  it('deletes an uncached candidate and streams a later cached one', async () => {
    const uncached = 'bbb'.repeat(10);
    const cached = 'ccc'.repeat(10);
    const { rd, calls } = fakeRd(new Set([cached]));
    const streams = await findCachedStreams(rd, [result(uncached), result(cached)], { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toContain('ccc');
    expect(calls.deleteId).toBe(`id-${uncached}`);
    expect(calls.addedHashes).toEqual([uncached, cached]);
  });

  it('deletes uncached candidates and returns no streams when nothing is cached', async () => {
    const uncached = 'ddd'.repeat(10);
    const { rd, calls } = fakeRd(new Set());
    const streams = await findCachedStreams(rd, [result(uncached), result('eee'.repeat(10))], { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toEqual([]);
    expect(calls.deleteId).toBe(`id-${'eee'.repeat(10)}`); // last one deleted too
  });

  it('stops probing after finding a few cached streams', async () => {
    const { rd } = fakeRd(new Set([`${'a'.repeat(10)}`, `${'b'.repeat(10)}`]));
    const streams = await findCachedStreams(rd, [
      result('a'.repeat(10), 1),
      result('b'.repeat(10), 2),
      result('c'.repeat(10), 3),
    ], { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams.length).toBeLessThanOrEqual(2);
  });

  it('returns no streams and does not delete when RD blocks the magnet (infringing_file)', async () => {
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      addMagnet: vi.fn(async () => {
        throw new Error('Real-Debrid API error 451: infringing_file');
      }),
      getTorrentInfo: vi.fn(),
      selectAllFiles: vi.fn(),
      deleteTorrent: vi.fn(),
    } as unknown as RdGateway;

    const negatives = new Set<string>();
    const streams = await findCachedStreams(rd, [result('aaa'.repeat(10))], { addDelayMs: 0, negatives });
    expect(streams).toEqual([]);
    expect(rd.deleteTorrent).not.toHaveBeenCalled();
    expect(negatives.has('aaa'.repeat(10))).toBe(true); // remembered as blocked
  });

  it('skips candidates already recorded as negative', async () => {
    const cached = 'ccc'.repeat(10);
    const { rd, calls } = fakeRd(new Set([cached]));
    const negatives = new Set(['bbb'.repeat(10)]); // pre-known blocked hash
    const streams = await findCachedStreams(
      rd,
      [result('bbb'.repeat(10)), result(cached)],
      { addDelayMs: 0, negatives },
    );
    expect(streams).toHaveLength(1);
    expect(calls.addedHashes).toEqual([cached]); // blocked one never re-added
  });

  it('stops probing further candidates when RD throttles adds (429)', async () => {
    const cached = 'ccc'.repeat(10);
    const { rd, calls } = fakeRd(new Set([cached]));
    // First add throttles; subsequent adds must never happen.
    rd.addMagnet = vi
      .fn()
      .mockRejectedValueOnce(new Error('Real-Debrid rate limit exceeded'))
      .mockImplementation(async (magnet: string) => {
        const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!.toLowerCase();
        calls.addedHashes.push(hash);
        return { id: `id-${hash}`, uri: magnet };
      });

    const streams = await findCachedStreams(rd, [result(cached), result('ddd'.repeat(10))], { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toEqual([]);
    expect(calls.addedHashes).toEqual([]); // nothing added after the throttle
  });
});

describe('findCachedStreams attempt cap', () => {
  it('stops adding after maxAttempts even when every candidate is blocked', async () => {
    const rd = {
      unrestrict: vi.fn(async (link: string) => ({ download: link, filename: link.split('/').pop()! })),
      addMagnet: vi.fn(async () => {
        throw new Error('Real-Debrid API error 451: infringing_file');
      }),
      getTorrentInfo: vi.fn(),
      selectAllFiles: vi.fn(),
      deleteTorrent: vi.fn(),
    } as unknown as RdGateway;

    await findCachedStreams(
      rd,
      ['a','b','c','d','e','f'].map((c) => result(c.repeat(10))),
      { addDelayMs: 0, maxAttempts: 2 },
    );
    expect(rd.addMagnet).toHaveBeenCalledTimes(2); // not all 6
  });
});

describe('probe failure recovery', () => {
  it('does not permanently blacklist a hash after throttling or a temporary API failure', async () => {
    for (const message of ['Real-Debrid rate limit exceeded', 'Could not reach the Real-Debrid API']) {
      const { rd } = fakeRd(new Set());
      rd.addMagnet = vi.fn().mockRejectedValue(new Error(message));
      const negatives = new Set<string>();
      await findCachedStreams(rd, [result('aaa')], { negatives, addDelayMs: 0 });
      expect([...negatives]).toEqual([]);
    }
  });

  it('waits through a brief downloading state before returning cached playback', async () => {
    const { rd } = fakeRd(new Set(['aaa']));
    const original = rd.getTorrentInfo;
    let polls = 0;
    rd.getTorrentInfo = vi.fn(async (id: string) => {
      polls++;
      if (polls === 2) return { id, status: 'downloading', links: [] } as never;
      return original(id);
    });
    const streams = await findCachedStreams(rd, [result('aaa')], { graceMs: 100, pollMs: 1 });
    expect(streams).toHaveLength(1);
  });

  it('cleans up a blocked selection and continues to another candidate', async () => {
    const { rd, calls } = fakeRd(new Set(['bbb']));
    rd.selectAllFiles = vi.fn().mockRejectedValueOnce(new Error('Real-Debrid API error 451: infringing_file')).mockResolvedValue(undefined);
    const negatives = new Set<string>();
    const streams = await findCachedStreams(rd, [result('aaa'), result('bbb')], { negatives, addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toHaveLength(1);
    expect(calls.deleteId).toBe('id-aaa');
    expect([...negatives]).toEqual(['aaa']);
  });

  it('allows an uncached hash to be retried later instead of persisting it as blocked', async () => {
    const { rd } = fakeRd(new Set());
    const negatives = new Set<string>();
    await findCachedStreams(rd, [result('aaa')], { negatives, addDelayMs: 0, graceMs: 10, pollMs: 1 });
    expect([...negatives]).toEqual([]);
  });
});

it('returns an already found stream without spending the full per-candidate grace on later misses', async () => {
  vi.useFakeTimers();
  try {
    const { rd } = fakeRd(new Set(['aaa']));
    const start = Date.now();
    const pending = findCachedStreams(rd, [result('aaa'), result('bbb'), result('ccc'), result('ddd')], { timeoutMs: 3000 });
    await vi.runAllTimersAsync();
    expect(await pending).toHaveLength(1);
    expect(Date.now() - start).toBeLessThanOrEqual(3000);
  } finally {
    vi.useRealTimers();
  }
});

it('reuses an existing cloud torrent instead of adding another copy', async () => {
  const { rd, calls } = fakeRd(new Set(['aaa']));
  // Advance the fixture past its initial selection state.
  await rd.getTorrentInfo('id-aaa');
  rd.listTorrents = async () => [{ id: 'id-aaa', hash: 'aaa', status: 'downloaded' }] as never;
  expect(await findCachedStreams(rd, [result('aaa')])).toHaveLength(1);
  expect(calls.addedHashes).toEqual([]);
});

it('never deletes a pre-existing cloud torrent when playback cannot be resolved', async () => {
  const { rd, calls } = fakeRd(new Set(['aaa']));
  rd.listTorrents = async () => [{ id: 'id-aaa', hash: 'aaa', status: 'downloaded' }] as never;
  rd.unrestrict = vi.fn().mockRejectedValue(new Error('temporary failure'));
  await findCachedStreams(rd, [result('aaa')]);
  expect(calls.deleteId).toBeNull();
});

describe('TorBox optional uncached downloads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function torbox(cached: Set<string>, allowUncached = false) {
    const fixture = fakeRd(cached);
    const rd = Object.assign(fixture.rd, {
      provider: 'torbox' as const,
      allowUncached,
      instantAvailability: async () => cached,
    });
    return { ...fixture, rd };
  }

  async function probe(rd: RdGateway, results: TorrentResult[]) {
    const pending = findCachedStreams(rd, results, { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    await vi.runAllTimersAsync();
    return pending;
  }

  it('prefers an available cached stream and does not queue uncached alternatives', async () => {
    const cached = 'c'.repeat(40);
    const ready = new Set([cached]);
    const fixture = torbox(ready, true);
    const streams = await probe(fixture.rd, [result('a'.repeat(40)), result(cached)]);
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toContain(cached);
    expect(fixture.calls.addedHashes).toEqual([cached]);
    expect(fixture.calls.deleteId).toBeNull();
  });

  it('queues at most one uncached torrent, preserves it, and returns a downloading status when enabled', async () => {
    const { rd, calls } = torbox(new Set(), true);
    const streams = await probe(rd, [result('a'.repeat(40)), result('b'.repeat(40)), result('c'.repeat(40))]);
    expect(streams).toEqual([expect.objectContaining({
      name: 'TorBox — downloading',
      description: expect.any(String),
      externalUrl: 'https://torbox.app/dashboard',
    })]);
    expect(streams[0].url).toBeUndefined();
    expect(calls.addedHashes).toHaveLength(1);
    expect(calls.deleteId).toBeNull();
  });

  it('does not add uncached torrents by default', async () => {
    const { rd, calls } = torbox(new Set());
    expect(await probe(rd, [result('a'.repeat(40))])).toEqual([]);
    expect(calls.addedHashes).toEqual([]);
  });

  it('reuses the queued cloud torrent and streams it after completion despite a cache API miss', async () => {
    const hash = 'a'.repeat(40);
    const completed = new Set<string>();
    const { rd, calls } = torbox(completed, true);
    rd.instantAvailability = async () => new Set();
    rd.listTorrents = async () => calls.addedHashes.map(hash => ({
      id: `id-${hash}`, hash, status: completed.has(hash) ? 'downloaded' : 'downloading',
    })) as never;

    expect(await probe(rd, [result(hash)])).toEqual([expect.objectContaining({ name: 'TorBox — downloading' })]);
    expect(await probe(rd, [result(hash)])).toEqual([expect.objectContaining({ name: 'TorBox — downloading' })]);
    expect(calls.addedHashes).toEqual([hash]);
    expect(calls.deleteId).toBeNull();

    completed.add(hash);
    const streams = await probe(rd, [result(hash)]);
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe(`https://mock/stream/${hash}.mkv`);
    expect(calls.addedHashes).toEqual([hash]);
    expect(calls.deleteId).toBeNull();
  });
});
