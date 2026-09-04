import { RealDebridError, isBlockedFileError, type RdGateway } from '../services/realdebrid.js';
import type { TorrentResult } from '../types.js';
import type { Stream } from '../stremio.js';
import { torrentStreams } from './resolver.js';

const DEFAULT_GRACE_MS = 8_000;
const DEFAULT_MAX = 3;

export interface ProbeOptions {
  season?: number;
  episode?: number;
  max?: number;
  /** How long to wait for RD to resolve a candidate before giving up on it. */
  graceMs?: number;
  pollMs?: number;
  /** Pause between add-magnet calls so RD does not throttle us. */
  addDelayMs?: number;
  /** Hashes known to be blocked; skipped and extended in place. */
  negatives?: Set<string>;
  /** Hard cap on add-magnet attempts per request (throttle safety). */
  maxAttempts?: number;
  /** Total polling/delay budget, shared by all candidates. */
  timeoutMs?: number;
  /** Require a confident title/episode match before starting a background download. */
  canDownload?: (result: TorrentResult) => boolean;
}

async function poll<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<T | null> {
  const start = Date.now();
  let last: T | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - start)))));
  }
  return last;
}

/**
 * Probe torrent index results against Real-Debrid to find the ones RD already
 * has cached. A cached magnet resolves to `downloaded` within seconds; an
 * uncached one stays `downloading`, so we delete it again to keep the user's
 * account clean and move on to the next candidate.
 */
export async function findCachedStreams(
  rd: RdGateway,
  results: TorrentResult[],
  opts: ProbeOptions = {},
): Promise<Stream[]> {
  let uncached: TorrentResult[] = [];
  // TorBox has its own authoritative cache; DMM/RD hits cannot stand in for it.
  if (rd.provider === 'torbox') {
    try {
      const cached = await rd.instantAvailability(results.map(r => r.infoHash));
      if (!cached) return [];
      if (rd.allowUncached) uncached = results.filter(r => !cached.has(r.infoHash)
        && !opts.negatives?.has(r.infoHash) && (!opts.canDownload || opts.canDownload(r)));
      results = results.filter(r => cached.has(r.infoHash));
    } catch {
      return [];
    }
  }
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = opts.pollMs ?? 500;
  const addDelayMs = opts.addDelayMs ?? 1_500;
  const max = opts.max ?? DEFAULT_MAX;
  const maxAttempts = opts.maxAttempts ?? 4;
  const streams: Stream[] = [];
  const stopAt = Date.now() + (opts.timeoutMs ?? 12_000);
  let existing: Map<string, string> | null = null;
  try {
    existing = new Map((await rd.listTorrents()).map(t => [t.hash.toLowerCase(), t.id]));
  } catch {
    // If the cloud list is unavailable, avoid deleting possibly existing data.
  }

  let attempts = 0;
  for (const r of results) {
    if (streams.length >= max || attempts >= maxAttempts || Date.now() >= stopAt) break;
    if (opts.negatives?.has(r.infoHash)) continue;
    if (attempts > 0 && addDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(addDelayMs, stopAt - Date.now())));
      if (Date.now() >= stopAt) break;
    }

    let id: string | undefined;
    const existingId = existing?.get(r.infoHash);
    let keep = false;
    attempts += 1;
    try {
      id = existingId ?? (await rd.addMagnet(`magnet:?xt=urn:btih:${r.infoHash}`)).id;
      const terminal = (status: string) => ['downloaded', 'error', 'magnet_error', 'virus', 'dead'].includes(status);
      const deadline = Math.min(stopAt, Date.now() + graceMs);
      let info = await poll(
        () => rd.getTorrentInfo(id!),
        (t) => t.status === 'waiting_files_selection' || terminal(t.status),
        Math.max(0, deadline - Date.now()),
        pollMs,
      );
      if (info?.status === 'waiting_files_selection') {
        await rd.selectAllFiles(id);
        info = await poll(
          () => rd.getTorrentInfo(id!),
          (t) => terminal(t.status),
          Math.max(0, deadline - Date.now()),
          pollMs,
        );
      }
      if (info?.status === 'downloaded') {
        const got = await torrentStreams(rd, info, opts.season, opts.episode, opts.negatives);
        keep = got.length > 0;
        streams.push(...got.slice(0, max - streams.length));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[probe] failed (${r.infoHash.slice(0, 8)}…):`, msg);
      if (isBlockedFileError(err)) opts.negatives?.add(r.infoHash);
      const throttled = (err instanceof RealDebridError && err.status === 429) || /throttl|rate limit/i.test(msg);
      if (throttled || (err instanceof RealDebridError && [401, 403].includes(err.status))) return streams;
    } finally {
      if (id && !keep && existing && !existingId) {
        try {
          await rd.deleteTorrent(id);
        } catch {
          // Cleanup failure must not hide a playable later candidate.
        }
      }
    }
  }

  // Download mode is a fallback, never an extra download beside working streams.
  // Reuse an existing candidate first and submit at most one uncached release.
  if (!streams.length && existing && max > 0 && attempts < maxAttempts && Date.now() < stopAt) {
    const candidate = uncached.find(r => existing!.has(r.infoHash)) ?? uncached[0];
    if (candidate) {
      const status = (message: string): Stream[] => [{
        name: 'TorBox — downloading',
        description: `${candidate.raw || candidate.title}\n${message}\nOpen the TorBox dashboard to check progress. Reopen this title when finished.`,
        externalUrl: 'https://torbox.app/dashboard',
      }];
      try {
        const id = existing.get(candidate.infoHash)
          ?? (await rd.addMagnet(`magnet:?xt=urn:btih:${candidate.infoHash}`, false)).id;
        if (!id) return status('Queued by TorBox.');
        try {
          const info = await rd.getTorrentInfo(id);
          if (info.status === 'downloaded') {
            const ready = await torrentStreams(rd, info, opts.season, opts.episode, opts.negatives);
            return ready.length ? ready.slice(0, max) : [{
              name: 'TorBox — check download', description: 'Download finished but no matching playable file was found.',
              externalUrl: 'https://torbox.app/dashboard',
            }];
          }
          return status(`Download status: ${info.status}.`);
        } catch {
          // Submission succeeded; retain it even if the next status read fails.
          return status('Submitted; waiting for TorBox status.');
        }
      } catch (err) {
        if (isBlockedFileError(err)) opts.negatives?.add(candidate.infoHash);
        console.warn('[download] submission failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }
  return streams;
}
