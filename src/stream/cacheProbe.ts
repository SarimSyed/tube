import { RealDebridError, isBlockedFileError, type RdGateway } from '../services/realdebrid.js';
import type { TorrentResult } from '../types.js';
import type { Stream } from '../stremio.js';
import { torrentStreams } from './resolver.js';
import { parseFilename, normalizeLanguage } from '../meta/parser.js';

const DEFAULT_GRACE_MS = 8_000;
const DEFAULT_MAX = 3;
/** Aim to show at least this many entries (cached + downloading) before giving up. */
const DOWNLOAD_TARGET = 30;
/** Never submit more than this many NEW downloads in a single stream request. */
const MAX_NEW_DOWNLOADS = 3;

/** Resolution -> rank for deterministic stream ordering (higher = better). */
const QUALITY_RANK: Record<string, number> = {
  '4320p': 6, '2160p': 5, '4k': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0,
};
function qualityRank(q?: string): number {
  if (!q) return -1;
  return QUALITY_RANK[q.toLowerCase()] ?? -1;
}

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
  /** Aim for this many total entries before considering download top-up. */
  downloadTarget?: number;
  /** Cap on NEW download submissions per request. */
  maxNewDownloads?: number;
  /** Languages to float to the top of the stream list (default: hindi/dual/multi). */
  preferredLanguages?: string[];
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
  const preferred = (opts.preferredLanguages && opts.preferredLanguages.length
    ? opts.preferredLanguages
    : ['hindi', 'dual', 'multi']).map((l) => normalizeLanguage(l));
  const isPreferred = (r: TorrentResult): boolean =>
    parseFilename(r.raw || r.title).languages.some((l) => preferred.includes(normalizeLanguage(l)));
  let uncached: TorrentResult[] = [];
  // TorBox has its own authoritative cache; DMM/RD hits cannot stand in for it.
  if (rd.provider === 'torbox') {
    try {
      const cached = await rd.instantAvailability(results.map(r => r.infoHash));
      if (!cached) return [];
      if (rd.allowUncached) uncached = results.filter(r => !cached.has(r.infoHash)
        && !opts.negatives?.has(r.infoHash) && (!opts.canDownload || opts.canDownload(r)));
      results = results.filter(r => cached.has(r.infoHash));
      // Deterministic order + collapse duplicate releases (same quality & size).
      results.sort((a, b) =>
        qualityRank(b.quality) - qualityRank(a.quality) ||
        (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
      const seen = new Set<string>();
      results = results.filter(r => {
        // Only collapse true duplicates (same quality AND known size); unknown
        // sizes (e.g. Zilean results) are kept distinct so every release shows.
        const key = r.sizeBytes != null ? `${r.quality ?? ''}|${r.sizeBytes}` : `${r.quality ?? ''}|hash:${r.infoHash}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (uncached.length) {
        uncached.sort((a, b) =>
          qualityRank(b.quality) - qualityRank(a.quality) ||
          (b.seeders ?? 0) - (a.seeders ?? 0) ||
          (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
        const uSeen = new Set<string>();
        uncached = uncached.filter(r => {
          const key = r.sizeBytes != null ? `${r.quality ?? ''}|${r.sizeBytes}` : `${r.quality ?? ''}|hash:${r.infoHash}`;
          if (uSeen.has(key)) return false;
          uSeen.add(key);
          return true;
        });
        const uPref = uncached.filter(isPreferred);
        if (uPref.length > 0) {
          const uOthers = uncached.filter((r) => !isPreferred(r));
          uncached = [...uPref.slice(0, 5), ...uOthers, ...uPref.slice(5)];
        }
      }
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

  // Top up a thin result set with a few downloads (TorBox download opt-in only).
  // Cached streams always come first; we submit extra uncached torrents only to
  const downloadTarget = opts.downloadTarget ?? DOWNLOAD_TARGET;
  const maxNewDownloads = opts.maxNewDownloads ?? MAX_NEW_DOWNLOADS;
  // fill the list up to downloadTarget, and never more than maxNewDownloads.
  if (rd.allowUncached && uncached.length > 0 && streams.length < downloadTarget
      && existing && max > 0 && attempts < maxAttempts && Date.now() < stopAt) {
    let newDownloads = 0;
    for (const candidate of uncached) {
      if (streams.length >= downloadTarget || newDownloads >= maxNewDownloads
          || attempts >= maxAttempts || Date.now() >= stopAt) break;
      if (opts.negatives?.has(candidate.infoHash)) continue;

      const qualitySuffix = candidate.quality ? ` ${candidate.quality.toUpperCase()}` : '';
      const cp = parseFilename(candidate.raw || candidate.title);
      const langSuffix = cp.languages?.length ? ` · ${cp.languages.join('/')}` : '';
      const status = (message: string): Stream => ({
        name: `TorBox — downloading${qualitySuffix}${langSuffix}`,
        description: `${candidate.raw || candidate.title}\n${message}\nOpen the TorBox dashboard to check progress. Reopen this title when finished.`,
        externalUrl: 'https://torbox.app/dashboard',
      });
      attempts += 1;
      try {
        let torrentId = existing.get(candidate.infoHash);
        if (!torrentId) {
          const added = await rd.addMagnet(`magnet:?xt=urn:btih:${candidate.infoHash}`, false);
          torrentId = added.id;
          newDownloads += 1;
        }
        if (!torrentId) {
          streams.push(status('Queued by TorBox.'));
          continue;
        }
        let info;
        try {
          info = await rd.getTorrentInfo(torrentId);
        } catch {
          // Submission succeeded; retain it even if the next status read fails.
          streams.push(status('Submitted; waiting for TorBox status.'));
          continue;
        }
        if (info.status === 'downloaded') {
          const ready = await torrentStreams(rd, info, opts.season, opts.episode, opts.negatives);
          const fresh = ready.filter((s) => s.url != null && !seenUrls.has(s.url));
          for (const s of fresh) seenUrls.add(s.url!);
          if (fresh.length) streams.push(fresh[0]);
          else streams.push({ name: 'TorBox — check download', description: 'Download finished but no matching playable file was found.', externalUrl: 'https://torbox.app/dashboard' });
        } else {
          streams.push(status(`Download status: ${info.status}.`));
        }
      } catch (err) {
        if (isBlockedFileError(err)) opts.negatives?.add(candidate.infoHash);
        console.warn('[download] submission failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }
  return streams;
}
