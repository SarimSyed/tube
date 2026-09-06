// Tests findCachedStreams, which adds index candidates to the debrid and polls
// until each resolves as cached ("downloaded") or is deleted. Uses a fake
// RdGateway plus vitest fake timers to cover both RD probing and the TorBox
// cache/download paths without network calls.
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

  it('keeps cached streams first and tops up with a download entry', async () => {
    const cached = 'c'.repeat(40);
    const ready = new Set([cached]);
    const fixture = torbox(ready, true);
    const streams = await probe(fixture.rd, [result('a'.repeat(40)), result(cached)]);
    expect(streams).toHaveLength(2);
    expect(streams[0].url).toContain(cached);           // cached stream first
    expect(streams[1].name).toBe('TorBox — downloading'); // then the download entry
    expect(streams[1].url).toBeUndefined();
    expect(fixture.calls.addedHashes).toEqual([cached, 'a'.repeat(40)]);
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

  it('flags season-pack downloads with the full-download caveat', async () => {
    const { rd } = torbox(new Set(), true);
    const pack: TorrentResult = {
      infoHash: 'f'.repeat(40), title: 'Show', sizeBytes: 1, isSeries: true, season: 1,
      raw: 'Show.S01.mkv', source: 'zilean',
    };
    const streams = await probe(rd, [pack]);
    expect(streams[0].description).toContain('Season packs must finish downloading fully');
  });

  it('filters low-quality candidates when minQuality is set', async () => {
    const hash = 'a'.repeat(40);
    const { rd } = torbox(new Set([hash]), false);
    const low: TorrentResult = { infoHash: hash, title: 'Movie', quality: '720p', sizeBytes: 1, isSeries: false, raw: 'Movie.2020.720p.mkv', source: 'zilean' };
    const streams = await findCachedStreams(rd, [low], { addDelayMs: 0, graceMs: 20, pollMs: 1, minQuality: '1080p' });
    expect(streams).toEqual([]);
  });

  it('excludes a listed source token from download candidates', async () => {
    const hash = 'a'.repeat(40);
    const { rd } = torbox(new Set([hash]), true);
    const cam: TorrentResult = { infoHash: hash, title: 'Movie', quality: '1080p', sizeBytes: 1, isSeries: false, raw: 'Movie.2020.1080p.HDCAM.mkv', source: 'zilean' };
    const streams = await findCachedStreams(rd, [cam], { addDelayMs: 0, graceMs: 20, pollMs: 1, excludeQuality: ['hdcam'] });
    expect(streams).toEqual([]);
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

describe('TorBox multi-quality streams', () => {
  interface Candidate { hash: string; quality: string; size: number; seeders?: number }

  function torboxGateway(candidates: Candidate[]) {
    const byHash = new Map(candidates.map(c => [c.hash, c]));
    return {
      provider: 'torbox' as const,
      allowUncached: false,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (magnet: string) => {
        const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!.toLowerCase();
        return { id: `id-${hash}`, uri: magnet };
      }),
      getTorrentInfo: vi.fn(async (id: string) => {
        const hash = id.replace(/^id-/, '');
        const c = byHash.get(hash)!;
        return {
          id, filename: `movie.${c.quality}.mkv`, status: 'downloaded', progress: 100,
          hash, bytes: c.size, added: '', seeders: c.seeders,
          files: [{ id: 0, path: `movie.${c.quality}.mkv`, bytes: c.size, selected: 1 }],
          links: [`torbox://${id}/0/movie.${c.quality}.mkv`],
        } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (link: string) => ({
        download: `https://dl.example/${link.split('/').pop()}`,
        filename: `movie.${link.split('/').pop()}`,
      })),
      instantAvailability: async () => new Set(candidates.map(c => c.hash)),
    } as unknown as RdGateway;
  }

  function resultOf(c: Candidate): TorrentResult {
    return { infoHash: c.hash, title: 'Movie', sizeBytes: c.size, quality: c.quality, isSeries: false, raw: c.quality, source: 'torznab', seeders: c.seeders };
  }

  it('returns multiple cached releases ordered by quality', async () => {
    const candidates: Candidate[] = [
      { hash: '7'.repeat(40), quality: '720p', size: 1_000_000_000 },
      { hash: '2'.repeat(40), quality: '2160p', size: 4_000_000_000 },
      { hash: '1'.repeat(40), quality: '1080p', size: 2_000_000_000 },
    ];
    const rd = torboxGateway(candidates);
    const streams = await findCachedStreams(rd, candidates.map(resultOf), { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toHaveLength(3);
    expect(streams.map(s => s.name)).toEqual(['TB 2160P ⚡', 'TB 1080P ⚡', 'TB 720P ⚡']);
  });

  it('collapses duplicate releases with the same quality and size', async () => {
    const candidates: Candidate[] = [
      { hash: 'a'.repeat(40), quality: '1080p', size: 2_000_000_000 },
      { hash: 'b'.repeat(40), quality: '1080p', size: 2_000_000_000 },
    ];
    const rd = torboxGateway(candidates);
    const streams = await findCachedStreams(rd, candidates.map(resultOf), { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toHaveLength(1);
  });

  it('includes seeders in the stream description when the index provides them', async () => {
    const candidates: Candidate[] = [{ hash: '9'.repeat(40), quality: '1080p', size: 2_000_000_000, seeders: 42 }];
    const rd = torboxGateway(candidates);
    const streams = await findCachedStreams(rd, candidates.map(resultOf), { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams[0].description).toContain('42 seeds');
  });
});


describe('TorBox download top-up', () => {
  interface Candidate { hash: string; quality: string; size: number }
  function gateway(cached: Candidate[], uncached: Candidate[]) {
    const byHash = new Map([...cached, ...uncached].map(c => [c.hash, c]));
    const cachedSet = new Set(cached.map(c => c.hash));
    return {
      provider: 'torbox' as const,
      allowUncached: true,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (magnet: string) => {
        const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!.toLowerCase();
        return { id: `id-${hash}`, uri: magnet };
      }),
      getTorrentInfo: vi.fn(async (id: string) => {
        const hash = id.replace(/^id-/, '');
        const c = byHash.get(hash)!;
        const ready = cachedSet.has(hash);
        return {
          id, filename: `movie.${c.quality}.mkv`, status: ready ? 'downloaded' : 'downloading',
          progress: ready ? 100 : 5, hash, bytes: c.size, added: '',
          files: [{ id: 0, path: `movie.${c.quality}.mkv`, bytes: c.size, selected: 1 }],
          links: ready ? [`torbox://${id}/0/movie.${c.quality}.mkv`] : [],
        } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (link: string) => ({ download: `https://dl/${link.split('/').pop()}`, filename: link.split('/').pop() })),
      instantAvailability: async () => cachedSet,
    } as unknown as RdGateway;
  }
  const res = (c: Candidate): TorrentResult => ({ infoHash: c.hash, title: 'Movie', sizeBytes: c.size, quality: c.quality, isSeries: false, raw: c.quality, source: 'piratebay' });

  it('does not download when five cached streams are already available', async () => {
    const cached: Candidate[] = ['2160p','1080p','720p','480p','360p'].map((q, i) => ({ hash: `${i}`.repeat(40), quality: q, size: (5-i)*1_000_000_000 }));
    const uncached: Candidate[] = [{ hash: 'x'.repeat(40), quality: '2160p', size: 9_000_000_000 }];
    const rd = gateway(cached, uncached);
    const streams = await findCachedStreams(rd, [...cached, ...uncached].map(res), { addDelayMs: 0, graceMs: 20, pollMs: 1, downloadTarget: 5 });
    expect(streams).toHaveLength(5);
    expect(streams.every(s => s.url)).toBe(true);
    expect(streams.some(s => s.name?.startsWith('TorBox — downloading'))).toBe(false);
    expect(rd.addMagnet.mock.calls.filter(c => String(c[1]) === 'false').length).toBe(0); // no uncached submitted
  });

  it('tops up below the target with downloads ordered by quality', async () => {
    const cached: Candidate[] = [{ hash: '1'.repeat(40), quality: '1080p', size: 2_000_000_000 }];
    const uncached: Candidate[] = [
      { hash: '2'.repeat(40), quality: '2160p', size: 4_000_000_000 },
      { hash: '3'.repeat(40), quality: '720p', size: 1_000_000_000 },
    ];
    const rd = gateway(cached, uncached);
    const streams = await findCachedStreams(rd, [...cached, ...uncached].map(res), { addDelayMs: 0, graceMs: 20, pollMs: 1, downloadTarget: 5 });
    expect(streams.map(s => s.name)).toEqual(['TB 1080P ⚡', 'TorBox — downloading 2160P', 'TorBox — downloading 720P']);
  });
});

describe('Hindi audio prioritization', () => {
  function hGateway(entries: Array<{ hash: string; raw: string; quality: string }>) {
    const byHash = new Map(entries.map(e => [e.hash, e]));
    return {
      provider: 'torbox' as const,
      allowUncached: false,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (magnet: string) => {
        const hash = (magnet.match(/btih:([0-9a-f]+)/i) || [])[1]!.toLowerCase();
        return { id: `id-${hash}`, uri: magnet };
      }),
      getTorrentInfo: vi.fn(async (id: string) => {
        const hash = id.replace(/^id-/, '');
        const e = byHash.get(hash)!;
        return {
          id, filename: e.raw, status: 'downloaded', progress: 100, hash, bytes: 1, added: '',
          files: [{ id: 0, path: e.raw, bytes: 1, selected: 1 }],
          links: [`torbox://${id}/0/${encodeURIComponent(e.raw)}`],
        } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (link: string) => ({ download: `https://dl/${link.split('/').pop()}`, filename: link.split('/').pop() })),
      instantAvailability: async () => new Set(entries.map(e => e.hash)),
    } as unknown as RdGateway;
  }

  it('floats five Hindi releases to the front even at lower quality', async () => {
    const entries = [
      { hash: 'a'.repeat(40), raw: 'Movie.2024.1440p.BluRay.x264.mkv', quality: '1440p' },
      { hash: 'b'.repeat(40), raw: 'Movie.2024.4320p.WEB-DL.mkv', quality: '4320p' },
      { hash: 'c'.repeat(40), raw: 'Movie.2024.2160p.Hindi.WEB-DL.mkv', quality: '2160p' },
      { hash: 'd'.repeat(40), raw: 'Movie.2024.1080p.Hindi.BluRay.mkv', quality: '1080p' },
      { hash: 'e'.repeat(40), raw: 'Movie.2024.720p.Hindi.DD5.1.mkv', quality: '720p' },
      { hash: 'f'.repeat(40), raw: 'Movie.2024.480p.Hindi.x264.mkv', quality: '480p' },
      { hash: '9'.repeat(40), raw: 'Movie.2024.360p.Hindi.HDRip.mkv', quality: '360p' },
    ];
    const rd = hGateway(entries);
    const results: TorrentResult[] = entries.map(e => ({
      infoHash: e.hash, title: 'Movie', raw: e.raw, quality: e.quality,
      sizeBytes: 1_000_000_000, isSeries: false, source: 'piratebay',
    }));
    const streams = await findCachedStreams(rd, results, { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    // The first five are the Hindi releases (floated above the two non-Hindi).
    for (let i = 0; i < 5; i++) expect(streams[i].name).toContain('Hindi');
  });
});

describe('dedupe with unknown sizes', () => {
  it('keeps same-quality releases distinct when size is unknown (Zilean)', async () => {
    const entries = [
      { hash: '1'.repeat(40), raw: 'Movie.2024.2160p.Remux.x265.mkv', quality: '2160p', size: undefined as unknown as number },
      { hash: '2'.repeat(40), raw: 'Movie.2024.2160p.WEB-DL.mkv', quality: '2160p', size: undefined as unknown as number },
    ];
    const byHash = new Map(entries.map(e => [e.hash, e]));
    const rd = {
      provider: 'torbox' as const,
      allowUncached: false,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (m: string) => ({ id: `id-${(m.match(/btih:([0-9a-f]+)/i) || [])[1]}`, uri: m })),
      getTorrentInfo: vi.fn(async (id: string) => {
        const hash = id.replace(/^id-/, '');
        const e = byHash.get(hash)!;
        return { id, filename: e.raw, status: 'downloaded', progress: 100, hash, bytes: 1, added: '', files: [{ id: 0, path: e.raw, bytes: 1, selected: 1 }], links: [`torbox://${id}/0/${e.raw}`] } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (l: string) => ({ download: `https://dl/${l.split('/').pop()}`, filename: l.split('/').pop() })),
      instantAvailability: async () => new Set(entries.map(e => e.hash)),
    } as unknown as RdGateway;
    const results: TorrentResult[] = entries.map(e => ({ infoHash: e.hash, title: 'Movie', raw: e.raw, quality: e.quality, sizeBytes: e.size, isSeries: false, source: 'zilean' }));
    const streams = await findCachedStreams(rd, results, { addDelayMs: 0, graceMs: 20, pollMs: 1 });
    expect(streams).toHaveLength(2);
  });
});

describe('duplicate-URL replacement', () => {
  it('fills the budget with distinct releases when a candidate is a URL duplicate', async () => {
    const candidates = [
      { hash: '1'.repeat(40), quality: '2160p', size: 5_000_000_000 },
      { hash: '2'.repeat(40), quality: '2160p', size: 6_000_000_000 },
      { hash: '3'.repeat(40), quality: '1080p', size: 2_000_000_000 },
    ];
    const byHash = new Map(candidates.map(c => [c.hash, c]));
    const rd = {
      provider: 'torbox' as const,
      allowUncached: false,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (m: string) => ({ id: `id-${(m.match(/btih:([0-9a-f]+)/i) || [])[1]}`, uri: m })),
      getTorrentInfo: vi.fn(async (id: string) => {
        const h = id.replace(/^id-/, '');
        const c = byHash.get(h)!;
        return {
          id, filename: `movie.${c.quality}.mkv`, status: 'downloaded', progress: 100, hash: h, bytes: c.size, added: '',
          files: [{ id: 0, path: `movie.${c.quality}.mkv`, bytes: c.size, selected: 1 }],
          links: [`torbox://${id}/0/movie.${c.quality}.mkv`],
        } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (l: string) => ({ download: `https://dl/${l.split('/').pop()}`, filename: l.split('/').pop() })),
      instantAvailability: async () => new Set(candidates.map(c => c.hash)),
    } as unknown as RdGateway;
    const results: TorrentResult[] = candidates.map(c => ({ infoHash: c.hash, title: 'Movie', raw: c.quality, quality: c.quality, sizeBytes: c.size, isSeries: false, source: 'zilean' }));
    const streams = await findCachedStreams(rd, results, { addDelayMs: 0, graceMs: 20, pollMs: 1, max: 2 });
    expect(streams.map(s => s.url)).toEqual(['https://dl/movie.2160p.mkv', 'https://dl/movie.1080p.mkv']);
  });
});

describe('custom preferred languages', () => {
  it('prefers a configured language list over the default Hindi/Dual/Multi', async () => {
    const entries = [
      { hash: '1'.repeat(40), raw: 'Movie.2024.2160p.WEB-DL.mkv', quality: '2160p' },
      { hash: '2'.repeat(40), raw: 'Movie.2024.720p.Tamil.x264.mkv', quality: '720p' },
      { hash: '3'.repeat(40), raw: 'Movie.2024.1080p.Hindi.BluRay.mkv', quality: '1080p' },
    ];
    const byHash = new Map(entries.map(e => [e.hash, e]));
    const rd = {
      provider: 'torbox' as const,
      allowUncached: false,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (m: string) => ({ id: `id-${(m.match(/btih:([0-9a-f]+)/i) || [])[1]}`, uri: m })),
      getTorrentInfo: vi.fn(async (id: string) => {
        const h = id.replace(/^id-/, '');
        const e = byHash.get(h)!;
        return { id, filename: e.raw, status: 'downloaded', progress: 100, hash: h, bytes: 1, added: '', files: [{ id: 0, path: e.raw, bytes: 1, selected: 1 }], links: [`torbox://${id}/0/${e.raw}`] } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (l: string) => ({ download: `https://dl/${l.split('/').pop()}`, filename: l.split('/').pop() })),
      instantAvailability: async () => new Set(entries.map(e => e.hash)),
    } as unknown as RdGateway;
    const results: TorrentResult[] = entries.map(e => ({ infoHash: e.hash, title: 'Movie', raw: e.raw, quality: e.quality, sizeBytes: 1_000_000_000, isSeries: false, source: 'piratebay' }));
    const streams = await findCachedStreams(rd, results, { addDelayMs: 0, graceMs: 20, pollMs: 1, preferredLanguages: ['tamil'] });
    expect(streams[0].name).toContain('Tamil');
  });
});

describe('episode candidate pre-filter', () => {
  it('only probes releases matching the requested season/episode', async () => {
    const episodes = [
      { hash: '1'.repeat(40), raw: 'Ludwig.S01E01.1080p.mkv', quality: '1080p', season: 1, episode: 1 },
      { hash: '2'.repeat(40), raw: 'Ludwig.S01E02.1080p.mkv', quality: '1080p', season: 1, episode: 2 },
      { hash: '3'.repeat(40), raw: 'Ludwig.S02E01.1080p.mkv', quality: '1080p', season: 2, episode: 1 },
    ];
    const added: string[] = [];
    const byHash = new Map(episodes.map(e => [e.hash, e]));
    const rd = {
      provider: 'torbox' as const,
      allowUncached: false,
      listTorrents: async () => [],
      addMagnet: vi.fn(async (m: string) => {
        const h = (m.match(/btih:([0-9a-f]+)/i) || [])[1]!;
        added.push(h);
        return { id: `id-${h}`, uri: m };
      }),
      getTorrentInfo: vi.fn(async (id: string) => {
        const h = id.replace(/^id-/, '');
        const e = byHash.get(h)!;
        return { id, filename: e.raw, status: 'downloaded', progress: 100, hash: h, bytes: 1, added: '', files: [{ id: 0, path: e.raw, bytes: 1, selected: 1 }], links: [`torbox://${id}/0/${e.raw}`] } as never;
      }),
      selectAllFiles: async () => {},
      deleteTorrent: vi.fn(async () => {}),
      unrestrict: vi.fn(async (l: string) => ({ download: `https://dl/${l.split('/').pop()}`, filename: l.split('/').pop() })),
      instantAvailability: async () => new Set(episodes.map(e => e.hash)),
    } as unknown as RdGateway;
    const results: TorrentResult[] = episodes.map(e => ({ infoHash: e.hash, title: 'Ludwig', raw: e.raw, quality: e.quality, sizeBytes: 1_000_000_000, season: e.season, episode: e.episode, isSeries: true, source: 'zilean' }));
    const streams = await findCachedStreams(rd, results, { addDelayMs: 0, graceMs: 20, pollMs: 1, season: 1, episode: 1 });
    expect(streams).toHaveLength(1);
    expect(added).toEqual(['1'.repeat(40)]); // only S01E01 was probed
  });
});
