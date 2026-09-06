// Builds the explicit "Download (uncached)" picker rows. Modeled on Comet's
// approach: every uncached release is its own clearly-labeled row below the
// cached streams, and clicking one is the only thing that starts a download
// (via the Tube action URL the row points at). Opening a title never starts a
// download by itself.
import type { Stream } from '../stremio.js';
import type { TorrentResult } from '../types.js';
import { parseFilename } from '../meta/parser.js';
import { compareStreamCandidates, passesQualityFilters } from './cacheProbe.js';

/** Options for {@link buildDownloadRows}. */
export interface DownloadRowOptions {
  /** Quality preferences (server + per-install profile) also gate download rows. */
  minQuality?: string;
  excludeQuality?: string[];
  maxResolution?: string;
  maxSizeBytes?: number;
  /** Hashes the provider already reported as blocked; skipped. */
  negatives?: Set<string>;
  /** Hashes already present in the user's cloud; skipped so a click never double-adds. */
  cloudHashes?: Set<string>;
  /** Languages floated to the top of the offered rows. */
  preferredLanguages?: string[];
  /** Builds the Tube download-action URL for a given info hash. */
  actionUrl: (infoHash: string) => string;
}

/** How many uncached releases to offer at most below the cached streams. */
export const MAX_DOWNLOAD_ROWS = 4;

/** Turn one uncached release into a "click to download" picker row. */
function downloadRow(r: TorrentResult, actionUrl: (infoHash: string) => string): Stream {
  const parsed = parseFilename(r.raw || r.title);
  const langLine = parsed.languages.length ? ` · ${parsed.languages.join('/')}` : '';
  const sizeLine = r.sizeBytes !== undefined ? `${(r.sizeBytes / 1024 ** 3).toFixed(1)} GB` : (r.sizeLabel ?? '');
  const seedsLine = r.seeders != null && r.seeders >= 0 ? ` · ${r.seeders} seeds` : '';
  // Provider limitation: a season pack (season, no episode) must finish
  // downloading entirely before any single episode becomes playable.
  const seasonPackNote = r.season !== undefined && r.episode === undefined
    ? '\nSeason packs must finish downloading fully before any episode plays.'
    : '';
  return {
    name: `Download ⬇ ${r.quality ?? 'release'}${langLine}`,
    description: `${r.raw || r.title}\n${sizeLine}${seedsLine}\nClick to add this release to your TorBox account; reopen the title when it finishes.${seasonPackNote}`,
    externalUrl: actionUrl(r.infoHash),
    behaviorHints: { notWebReady: true, filename: r.raw || r.title, videoSize: r.sizeBytes },
  };
}

/**
 * Pick and order the uncached releases worth offering, deduped and capped.
 * Only releases that pass the quality/size profile, are not blocked, and are
 * not already in the cloud are offered — each as its own click-to-download row.
 */
export function buildDownloadRows(candidates: TorrentResult[], opts: DownloadRowOptions): Stream[] {
  const eligible: TorrentResult[] = [];
  const seen = new Set<string>();
  for (const r of candidates) {
    if (!r.infoHash) continue;
    if (!passesQualityFilters(r, opts.minQuality, opts.excludeQuality, opts.maxResolution, opts.maxSizeBytes)) continue;
    if (opts.negatives?.has(r.infoHash)) continue;
    if (opts.cloudHashes?.has(r.infoHash)) continue;
    // Collapse duplicate releases (same quality + known size) like the cached path.
    const key = r.sizeBytes !== undefined
      ? `${r.quality ?? ''}|${r.sizeBytes}`
      : `${r.quality ?? ''}|hash:${r.infoHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(r);
  }
  eligible.sort((a, b) => compareStreamCandidates(a, b, opts.preferredLanguages));
  return eligible.slice(0, MAX_DOWNLOAD_ROWS).map((r) => downloadRow(r, opts.actionUrl));
}
