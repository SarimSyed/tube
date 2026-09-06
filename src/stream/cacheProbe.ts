/**
 * Bounded cache-availability probing for torrent-index candidates.
 *
 * `findCachedStreams` adds releases the debrid already has cached and turns
 * them into playable stream objects. It never starts an uncached download:
 * callers decide what uncached candidates to offer as explicit download rows.
 * Positive availability is delegated to the provider (the `CachedRealDebrid`
 * wrapper TTL-caches it); negative results — hashes the provider reports as
 * blocked/infringing — are recorded in the caller-supplied `negatives` set
 * (backed by `NegativeStore` or the `misc` cache's `probe-neg` key) so they
 * are skipped on later requests. Temporary errors and uncached files are never
 * stored as negatives.
 */
import { RealDebridError, isBlockedFileError, type RdGateway } from '../services/realdebrid.js';
import type { TorrentResult } from '../types.js';
import type { Stream } from '../stremio.js';
import { torrentStreams } from './resolver.js';
import { parseFilename, normalizeLanguage } from '../meta/parser.js';

/** Default grace window (ms) for an RD candidate to reach a terminal state. */
const DEFAULT_GRACE_MS = 8_000;
/** Default cap on returned RD streams. */
const DEFAULT_MAX = 3;
/** TorBox: spend at most this long adding cached releases before returning. */
const DEFAULT_TORBOX_ADD_BUDGET_MS = 5_000;

/** Resolution -> rank for deterministic stream ordering (higher = better). */
const QUALITY_RANK: Record<string, number> = {
  '4320p': 6, '2160p': 5, '4k': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0,
};
/** Map a quality label to a comparable rank; unknown/absent labels sort last. */
export function qualityRank(q?: string): number {
  if (!q) return -1;
  return QUALITY_RANK[q.toLowerCase()] ?? -1;
}

/** True when a result's parsed filename carries one of the (normalized) languages. */
export function hasPreferredLanguage(result: TorrentResult, preferred: string[]): boolean {
  return parseFilename(result.raw || result.title).languages
    .some((l) => preferred.includes(normalizeLanguage(l)));
}

/**
 * Deterministic comparator for torrent candidates: quality, then seeders, then
 * size, then preferred language. Returns a negative number when `a` should sort
 * before `b` (i.e. `a` is better). Callers that already rank by title/episode
 * correctness can use this as their tie-break so the picker order is stable.
 */
export function compareStreamCandidates(a: TorrentResult, b: TorrentResult, preferredLanguages?: string[]): number {
  const preferred = preferredLanguages && preferredLanguages.length
    ? preferredLanguages.map(normalizeLanguage)
    : undefined;

  const byQuality = qualityRank(b.quality) - qualityRank(a.quality);
  if (byQuality !== 0) return byQuality;
  const bySeeders = (b.seeders ?? 0) - (a.seeders ?? 0);
  if (bySeeders !== 0) return bySeeders;
  const bySize = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  if (bySize !== 0) return bySize;
  if (preferred) {
    const aPref = hasPreferredLanguage(a, preferred) ? 1 : 0;
    const bPref = hasPreferredLanguage(b, preferred) ? 1 : 0;
    if (aPref !== bPref) return bPref - aPref;
  }
  return 0;
}

/** Build a literal whole-word RegExp for a token (metacharacters escaped). */
function wordPattern(token: string): RegExp {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

/**
 * True when a result passes the configured quality preferences.
 * `minQuality` / `maxResolution` drop known resolutions outside the allowed
 * band (unknown resolutions are kept — e.g. Zilean results without one);
 * `excludeQuality` drops results whose raw title/quality mention any of the
 * listed tokens (e.g. "hdcam"); `maxSizeBytes` drops results larger than the
 * per-install cap (unknown sizes are kept).
 */
export function passesQualityFilters(
  result: TorrentResult,
  minQuality?: string,
  excludeQuality?: string[],
  maxResolution?: string,
  maxSizeBytes?: number,
): boolean {
  if (minQuality && result.quality && qualityRank(result.quality) < qualityRank(minQuality)) return false;
  if (maxResolution && result.quality && qualityRank(result.quality) > qualityRank(maxResolution)) return false;
  if (maxSizeBytes !== undefined && result.sizeBytes !== undefined && result.sizeBytes > maxSizeBytes) return false;
  if (excludeQuality && excludeQuality.length) {
    const hay = `${result.raw ?? ''} ${result.title ?? ''} ${result.quality ?? ''}`.toLowerCase();
    for (const token of excludeQuality) {
      if (wordPattern(token.toLowerCase()).test(hay)) return false;
    }
  }
  return true;
}

/** Tunables for `findCachedStreams`; every field is optional with sane defaults. */
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
  /** Once this many ms pass with streams in hand, stop adding more releases
   * (TorBox cached loop; keeps the picker responsive and grows breadth over
   * later opens instead of waiting on every release up front). */
  cachedBudgetMs?: number;
  /** Languages to float to the top of the stream list (default: hindi/dual/multi). */
  preferredLanguages?: string[];
  /** Minimum resolution (e.g. "1080p"); unknown qualities are kept. */
  minQuality?: string;
  /** Source/quality tokens to exclude (matched as whole words against the raw name). */
  excludeQuality?: string[];
  /** Highest resolution to offer (e.g. "1080p") — per-install cap. */
  maxResolution?: string;
  /** Largest file to offer in bytes — per-install cap (unknown sizes kept). */
  maxSizeBytes?: number;
}

/** Poll `fn` until `predicate` passes or `timeoutMs` elapses, returning the last value. */
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
 * Adds the releases the debrid already has cached and returns playable streams.
 * A cached magnet resolves to `downloaded` quickly; a candidate that stays
 * `downloading` (not actually cached) is deleted again to keep the account
 * clean. Uncached releases are NEVER added here — callers surface them as
 * explicit download rows instead.
 *
 * For TorBox the provider cache check is authoritative, so confirmed-cached
 * releases are added quickly (no RD-style throttle) within a short time budget.
 *
 * @returns Playable streams — cached releases first, capped by `opts.max`.
 */
export async function findCachedStreams(
  rd: RdGateway,
  results: TorrentResult[],
  opts: ProbeOptions = {},
): Promise<Stream[]> {
  // Apply configured quality preferences before any probing, so out-of-band
  // releases are neither added to the debrid nor returned as streams.
  results = results.filter((r) => passesQualityFilters(
    r, opts.minQuality, opts.excludeQuality, opts.maxResolution, opts.maxSizeBytes,
  ));

  const preferred = (opts.preferredLanguages && opts.preferredLanguages.length
    ? opts.preferredLanguages
    : ['hindi', 'dual', 'multi']).map((l) => normalizeLanguage(l));
  const isPreferred = (r: TorrentResult): boolean => hasPreferredLanguage(r, preferred);
  // TorBox has its own authoritative cache; DMM/RD hits cannot stand in for it.
  // Only releases it reports as cached are added here — uncached candidates are
  // the caller's business (explicit download rows), never auto-started.
  if (rd.provider === 'torbox') {
    try {
      const cached = await rd.instantAvailability(results.map(r => r.infoHash));
      if (!cached) return [];
      results = results.filter(r => cached.has(r.infoHash));
      // Deterministic order + collapse duplicate releases (same quality & size).
      results.sort((a, b) => compareStreamCandidates(a, b));
      const seen = new Set<string>();
      results = results.filter(r => {
        // Only collapse true duplicates (same quality AND known size); unknown
        // sizes (e.g. Zilean results) are kept distinct so every release shows.
        const key = r.sizeBytes != null ? `${r.quality ?? ''}|${r.sizeBytes}` : `${r.quality ?? ''}|hash:${r.infoHash}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      return [];
    }
  }
  // TorBox's cache check is authoritative, so cached torrents can be added
  // quickly (no RD-style throttle); collect several releases per request.
  const isTorbox = rd.provider === 'torbox';
  // Surface preferred-language releases ahead of the rest (cached list).
  const pref = results.filter(isPreferred);
  if (pref.length > 0) {
    const others = results.filter((r) => !isPreferred(r));
    results = [...pref.slice(0, 5), ...others, ...pref.slice(5)];
  }

  const graceMs = opts.graceMs ?? (isTorbox ? 3_000 : DEFAULT_GRACE_MS);
  const pollMs = opts.pollMs ?? 500;
  const addDelayMs = opts.addDelayMs ?? (isTorbox ? 0 : 1_500);
  const max = opts.max ?? (isTorbox ? 30 : DEFAULT_MAX);
  const maxAttempts = opts.maxAttempts ?? (isTorbox ? 40 : 4);
  // Time-box how long the cached-add loop spends per request (TorBox only).
  const cachedBudgetMs = opts.cachedBudgetMs ?? (isTorbox ? DEFAULT_TORBOX_ADD_BUDGET_MS : 0);
  const cachedStart = Date.now();
  const streams: Stream[] = [];
  const seenUrls = new Set<string>();
  const stopAt = Date.now() + (opts.timeoutMs ?? (isTorbox ? 60_000 : 12_000));
  let existing: Map<string, string> | null = null;
  try {
    existing = new Map((await rd.listTorrents()).map(t => [t.hash.toLowerCase(), t.id]));
  } catch {
    // If the cloud list is unavailable, avoid deleting possibly existing data.
  }

  let attempts = 0;
  for (const r of results) {
    if (streams.length >= max || attempts >= maxAttempts || Date.now() >= stopAt) break;
    // Once we hold at least one playable stream, stop adding after the budget
    // elapses: TorBox resolves cached adds quickly, so this bounds worst-case
    // latency while already-added releases make the next open near-instant.
    if (cachedBudgetMs > 0 && streams.length > 0 && Date.now() - cachedStart >= cachedBudgetMs) break;
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
      // Terminal states stop polling: either playable or a hard failure.
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
        // Provider torrent info may already carry seeders; only fall back to the
        // index result's seeders when the provider did not report any.
        if (r.seeders != null && r.seeders >= 0 && (info.seeders == null || info.seeders < 0)) {
          for (const stream of got) {
            if (stream.description != null) stream.description = `${stream.description}\n${r.seeders} seeds`;
          }
        }
        const fresh = got.filter((s) => s.url != null && !seenUrls.has(s.url));
        for (const s of fresh) seenUrls.add(s.url!);
        streams.push(...fresh.slice(0, max - streams.length));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[probe] failed (${r.infoHash.slice(0, 8)}…):`, msg);
      // A confirmed block is recorded (persisted) and this candidate is skipped;
      // throttle/auth errors are not negatives — they abort the whole probe.
      if (isBlockedFileError(err)) opts.negatives?.add(r.infoHash);
      const throttled = (err instanceof RealDebridError && err.status === 429) || /throttl|rate limit/i.test(msg);
      if (throttled || (err instanceof RealDebridError && [401, 403].includes(err.status))) {
        // Back off rather than hammer the provider further — RD throttling is a
        // signal to stop, and an auth/denial will not resolve by retrying. Keep
        // whatever streams were already found.
        console.warn(`[probe] stopped probing on ${err instanceof RealDebridError ? `HTTP ${err.status}` : 'throttle'} (${msg}) after ${streams.length} stream(s) — provider is limiting requests`);
        return streams;
      }
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

  return streams;
}
