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
import { parseLibraryId, parseSearchId, parseSearchContext } from '../id.js';
import { parseFilename, isVideoFile } from '../meta/parser.js';

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

function playableStream(url: string, filename: string, bytes: number, provider?: string): Stream | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const p = parseFilename(filename);
  const label = provider === 'torbox' ? 'TB' : 'RD';
  return {
    url,
    name: p.quality ? `${label} ${p.quality}` : provider === 'torbox' ? 'TorBox' : 'Real-Debrid',
    description: [filename, formatBytes(bytes)].filter(Boolean).join('\n'),
    behaviorHints: {
      bingeGroup: `tube-${label.toLowerCase()}`,
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

/** Build playable streams from a downloaded RD torrent (optionally one episode). */
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

  const streams: Stream[] = [];
  for (const { file, url } of candidates) {
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
      continue;
    }
    const stream = playableStream(direct, title, file.bytes, rd.provider);
    if (stream) streams.push(stream);
  }
  return streams;
}

function notReadyStream(message: string): StreamResponse {
  console.warn(`[stream] ${message}`);
  return { streams: [] };
}

export class StreamResolver {
  constructor(
    private rd: RdGateway,
    private deps: {
      search?: SearchService;
      caches?: CacheSet;
      negatives?: NegativeStore;
    } = {},
  ) {}

  async resolve(id: string): Promise<StreamResponse> {
    const libraryId = parseLibraryId(id);
    if (libraryId) return this.resolveLibrary(libraryId);

    const hash = parseSearchId(id);
    if (hash) return this.resolveSearch(hash, parseSearchContext(id));

    return { streams: [] };
  }

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
      // Prefilter to index-known cached copies (same as the tt path) so we only
      // add torrents likely to be instant and avoid RD add-throttling.
      try {
        const cached = this.rd.provider === 'torbox' ? new Set<string>() : await this.deps.search.checkCached(candidates.map((r) => r.infoHash));
        if (cached.size > 0) candidates = candidates.filter((r) => cached.has(r.infoHash));
      } catch {
        // unknown cache state — probe everything
      }
      const streams = await findCachedStreams(this.rd, candidates, {
        season: result.season,
        episode: result.episode,
        negatives,
      });
      this.deps.negatives?.saveSoon();
      return { streams };
    }

    // Legacy IDs use the same bounded probing and blocked-file handling.
    const streams = await findCachedStreams(this.rd, [{
      infoHash: hash, title: hash, raw: hash, isSeries: false, source: 'zilean',
    }], { negatives: this.deps.negatives?.get() });
    this.deps.negatives?.saveSoon();
    return { streams };
  }
}
