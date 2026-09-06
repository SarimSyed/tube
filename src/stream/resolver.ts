/**
 * Turns a chosen torrent/library item into direct, playable stream URLs.
 *
 * `StreamResolver` dispatches on this addon's own ids (`rd:` library ids and
 * `sr:` search ids) and delegates cache-availability probing to
 * `findCachedStreams`. The resulting stream URLs point straight at the debrid
 * provider; video never flows through the addon.
 */
import type { RdTorrent } from '../types.js';
import type { Stream, StreamResponse } from '../stremio.js';
import type { RdGateway } from '../services/realdebrid.js';
import { isBlockedFileError } from '../services/realdebrid.js';
import type { SearchService } from '../services/search.js';
import { sameTitle } from '../services/search.js';
import type { CacheSet } from '../services/cache.js';
import type { NegativeStore } from '../services/negativeStore.js';
import type { TorrentResult } from '../types.js';
import { findCachedStreams } from './cacheProbe.js';
import { buildDownloadRows } from './downloadRows.js';
import { parseLibraryId, parseSearchId, parseSearchContext } from '../id.js';
import { parseFilename, isVideoFile } from '../meta/parser.js';
import { mapLimit } from '../util.js';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Build a Stremio stream object from a direct URL and parsed filename metadata. */
function playableStream(url: string, filename: string, bytes: number, provider?: string, seeders?: number): Stream | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const p = parseFilename(filename);
  const label = provider === 'torbox' ? 'TB' : 'RD';
  const seedersLine = seeders != null && seeders >= 0 ? `${seeders} seeds` : '';
  const langLine = p.languages?.length ? ` · ${p.languages.join('/')}` : '';
  return {
    url,
    name: `${label}${p.quality ? ` ${p.quality}` : ''}${langLine} ⚡`,
    description: [filename, formatBytes(bytes), seedersLine].filter(Boolean).join('\n'),
    behaviorHints: {
      bingeGroup: `tube-${label.toLowerCase()}`,
      // Web players only handle direct https mp4; anything else needs a player.
      notWebReady: parsed.protocol !== 'https:' || !/\.mp4$/i.test(filename),
      filename,
      videoSize: bytes,
    },
  };
}

/** Map RD `links` (download URLs) to their source files, preferring filename match. */
function resolveFiles(torrent: RdTorrent): Array<{ file: { id: number; path: string; bytes: number; selected: number }; url: string }> {
  const files = torrent.files ?? [];
  const links = torrent.links ?? [];
  const selected = files.filter((f) => f.selected !== 0);
  const result: Array<{ file: { id: number; path: string; bytes: number; selected: number }; url: string }> = [];

  links.forEach((url, idx) => {
    let filename: string | null = null;
    try {
      const path = new URL(url).pathname;
      filename = decodeURIComponent(path.split('/').pop() ?? '');
    } catch {
      filename = null;
    }
    let file: { id: number; path: string; bytes: number; selected: number } | undefined;
    if (filename) {
      file = selected.find((f) => basename(f.path) === filename);
    }
    if (!file) file = selected[idx];
    if (file) result.push({ file, url });
  });

  return result;
}

/**
 * Build playable streams from a downloaded torrent (optionally one episode).
 * Maps each download link to its source file (filename match preferred,
 * positional fallback), filters to video files, restricts each via
 * `unrestrict` to get the direct URL, and records the hash in `negatives` when
 * a file is reported blocked/infringing.
 */
export async function torrentStreams(
  rd: RdGateway,
  torrent: RdTorrent,
  season?: number,
  episode?: number,
  negatives?: Set<string>,
): Promise<Stream[]> {
  const pairs = resolveFiles(torrent);
  let candidates = pairs.filter(({ file }) => isVideoFile(file.path) && !/sample/i.test(file.path));

  if (season !== undefined && episode !== undefined) {
    const matched = candidates.filter(({ file }) => {
      const p = parseFilename(basename(file.path));
      return p.season === season && p.episode === episode;
    });
    candidates = matched;
  }

  const streams = await mapLimit(candidates, 3, async ({ file, url }) => {
    // `links[]` points at an HTML landing page; unrestrict gives the direct file.
    let direct: string;
    let title = basename(file.path);
    try {
      const u = await rd.unrestrict(url);
      direct = u.download;
      if (u.filename) title = u.filename;
    } catch (err) {
      console.warn('[stream] unrestrict failed:', err instanceof Error ? err.message : err);
      if (isBlockedFileError(err)) negatives?.add(torrent.hash);
      return null;
    }
    return playableStream(direct, title, file.bytes, rd.provider, torrent.seeders);
  });
  return streams.filter((s): s is Stream => s !== null);
}

/** Log a not-ready reason and return an empty stream list. */
function notReadyStream(message: string): StreamResponse {
  console.warn(`[stream] ${message}`);
  return { streams: [] };
}

/**
 * Resolves this addon's own stream ids into direct URLs. Library ids (`rd:…`)
 * resolve from the user's cloud (torrents or web downloads); search ids
 * (`sr:…`) resolve via bounded cache-probing against the debrid provider.
 */
export class StreamResolver {
  /**
   * @param rd Debrid gateway (Real-Debrid or TorBox).
   * @param deps Optional services — search + caches + negatives enable the
   *   search-id probe path (library ids only need `rd`).
   */
  constructor(
    private rd: RdGateway,
    private deps: {
      search?: SearchService;
      caches?: CacheSet;
      negatives?: NegativeStore;
      preferredLanguages?: string[];
      /** Builds the Tube action URL for a "Download (uncached)" row. */
      downloadActionUrl?: (infoHash: string) => string;
    } = {},
  ) {}

  /**
   * Dispatch on id shape: `rd:` library ids resolve from the cloud, `sr:`
   * search ids resolve via cache-probing. Anything else yields no streams.
   */
  async resolve(id: string): Promise<StreamResponse> {
    const libraryId = parseLibraryId(id);
    if (libraryId) return this.resolveLibrary(libraryId);

    const hash = parseSearchId(id);
    if (hash) return this.resolveSearch(hash, parseSearchContext(id));

    return { streams: [] };
  }

  /**
   * Resolve a cloud library item. Web downloads stream directly; torrents must
   * be `downloaded` first. Episode ids narrow the result to that
   * season/episode.
   */
  private async resolveLibrary(libraryId: ReturnType<typeof parseLibraryId>): Promise<StreamResponse> {
    if (!libraryId) return { streams: [] };

    if (libraryId.kind === 'download') {
      const downloads = await this.rd.listDownloads();
      const found = downloads.find((d) => d.id === libraryId.downloadId);
      if (!found) return { streams: [] };
      const stream = playableStream(found.download, found.filename, found.filesize, this.rd.provider);
      return { streams: stream ? [stream] : [] };
    }

    const info = await this.rd.getTorrentInfo(libraryId.torrentId);
    if (info.status !== 'downloaded') {
      return notReadyStream(`Torrent is "${info.status}" — not ready to stream yet`);
    }

    const season = libraryId.kind === 'episode' ? libraryId.season : undefined;
    const episode = libraryId.kind === 'episode' ? libraryId.episode : undefined;
    const streams = await torrentStreams(this.rd, info, season, episode);
    return { streams: streams.length ? streams : notReadyStream('No playable video file in this torrent').streams };
  }

  /**
   * Resolve a search id. When the clicked result's context is known, probe its
   * title's cached copies (clicked one first) so a blocked/uncached pick falls
   * through to another; legacy ids probe just the bare hash.
   */
  private async resolveSearch(hash: string, context: TorrentResult | null): Promise<StreamResponse> {
    const result = context ?? this.deps.caches?.search.get(`result:${hash}`) as TorrentResult | undefined;

    // When we know the clicked title, probe its cached copies (including the
    // clicked one first) so a blocked/uncached pick falls through to another.
    if (result && this.deps.search && this.deps.caches) {
      const negatives = this.deps.negatives?.get();
      const type = result.isSeries ? 'series' : 'movie';
      let candidates: TorrentResult[] = [result];
      try {
        const others = await this.deps.search.search(result.title, type);
        candidates = [result, ...others.filter((r) => r.infoHash !== hash && sameTitle(result, r)
          && (result.season === undefined || r.season === undefined || result.season === r.season)
          && (result.episode === undefined || r.episode === undefined || result.episode === r.episode))];
      } catch {
        // keep just the clicked candidate
      }
      // Split the clicked title's releases into cached (playable now) and
      // uncached (explicit download rows). Nothing uncached is auto-started.
      let playable: TorrentResult[] = candidates;
      let uncached: TorrentResult[] = [];
      if (this.rd.provider === 'torbox') {
        try {
          const cached = await this.rd.instantAvailability(candidates.map((r) => r.infoHash));
          if (cached) {
            playable = candidates.filter((r) => cached.has(r.infoHash));
            uncached = candidates.filter((r) => !cached.has(r.infoHash));
          }
        } catch {
          // Availability check failed — probe the candidates we have.
        }
      } else {
        try {
          const cached = await this.deps.search.checkCached(candidates.map((r) => r.infoHash));
          playable = cached.size > 0 ? candidates.filter((r) => cached.has(r.infoHash)) : candidates;
        } catch {
          playable = candidates; // unknown cache state — probe what we have
        }
      }
      const streams = await findCachedStreams(this.rd, playable, {
        season: result.season,
        episode: result.episode,
        negatives,
        preferredLanguages: this.deps.preferredLanguages?.length ? this.deps.preferredLanguages : undefined,
      });
      // Explicit downloads (TorBox download-enabled installs): offer the
      // uncached releases as click-to-download rows instead of auto-adding.
      if (this.rd.allowUncached && this.deps.downloadActionUrl) {
        streams.push(...buildDownloadRows(uncached, {
          negatives,
          actionUrl: this.deps.downloadActionUrl,
        }));
      }
      this.deps.negatives?.saveSoon();
      return { streams };
    }

    // Legacy IDs (no title context): cached ones probe normally; an uncached
    // TorBox click becomes an explicit download row.
    if (this.rd.provider === 'torbox' && this.rd.allowUncached && this.deps.downloadActionUrl) {
      try {
        const cached = await this.rd.instantAvailability([hash]);
        if (cached && !cached.has(hash)) {
          const legacy: TorrentResult = { infoHash: hash, title: hash, raw: hash, isSeries: false, source: 'zilean' };
          return { streams: buildDownloadRows([legacy], { negatives: this.deps.negatives?.get(), actionUrl: this.deps.downloadActionUrl }) };
        }
      } catch {
        // fall through to normal probing
      }
    }
    const streams = await findCachedStreams(this.rd, [{
      infoHash: hash, title: hash, raw: hash, isSeries: false, source: 'zilean',
    }], { negatives: this.deps.negatives?.get() });
    this.deps.negatives?.saveSoon();
    return { streams };
  }
}
