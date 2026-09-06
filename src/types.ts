// Shared domain types for the Tube addon.

/** Movie or series content type. */
export type ContentType = 'movie' | 'series';

/** A torrent as returned by Real-Debrid `GET /torrents` (list) — lighter shape. */
export interface RdTorrentSummary {
  id: string;
  filename: string;
  hash: string;
  bytes: number;
  status: string;
  progress: number;
  added: string;
  seeders?: number;
}

/** A single file inside a Real-Debrid torrent. */
export interface RdFile {
  id: number;
  path: string;
  bytes: number;
  selected: number;
}

/** A torrent as returned by Real-Debrid `GET /torrents/info/{id}` — full shape. */
export interface RdTorrent extends RdTorrentSummary {
  original_filename?: string;
  host?: string;
  files?: RdFile[];
  links?: string[];
  ended?: string;
  speed?: number;
}

/** An unrestricted hoster download from Real-Debrid `GET /downloads`. */
export interface RdDownload {
  id: string;
  filename: string;
  mimeType?: string;
  filesize: number;
  link: string;
  host: string;
  download: string;
  generated: string;
}

/** A parsed media filename. */
export interface ParsedMedia {
  /** Cleaned title, e.g. "The Matrix". */
  title: string;
  /** Release year, when parseable. */
  year?: number;
  /** True when the filename looks like a TV series (season/episode present). */
  isSeries: boolean;
  /** Season number, when parseable. */
  season?: number;
  /** Episode number, when parseable. */
  episode?: number;
  /** Human readable quality label, e.g. "2160p", "1080p", "720p". */
  quality?: string;
  /** Group / release tag, e.g. "GECKOS". */
  group?: string;
  /** Detected audio languages, e.g. ["Hindi", "Dual"]. */
  languages: string[];
  /** Original filename the result was parsed from. */
  raw: string;
}

/** A normalized torrent search result (from Zilean / Torznab). */
export interface TorrentResult {
  infoHash: string;
  title: string;
  sizeBytes?: number;
  sizeLabel?: string;
  quality?: string;
  year?: number;
  season?: number;
  episode?: number;
  isSeries: boolean;
  category?: string;
  imdbId?: string;
  seeders?: number;
  raw: string;
  source: 'zilean' | 'torznab' | 'piratebay' | 'yts';
}

/** TMDB metadata used to enrich metas. */
export interface EnrichedMeta {
  name: string;
  poster: string | null;
  background: string | null;
  year?: number;
  description?: string;
  imdbId?: string;
}

/** A torrent search index queried during search. */
export interface TorrentProvider {
  name: string;
  search(query: string): Promise<TorrentResult[]>;
  /** Optional: which of the given hashes the index says are cached on a debrid. */
  checkCached?(hashes: string[]): Promise<Set<string>>;
}

/** Runtime configuration, loaded from environment variables by `loadConfig`. */
export interface Config {
  /** HTTP port the addon listens on. */
  port: number;
  /** Override the Real-Debrid API base URL (for tests/mocks). */
  rdApiBase: string | null;
  /** Override the TorBox API base URL (for tests/mocks). */
  torboxApiBase: string | null;
  /** Writable directory for persisted state (negative cache). */
  dataDir: string;
  /** Public base URL override; when empty, derived from the incoming request. */
  baseUrl: string;
  /** Fallback Real-Debrid token used when none is embedded in the request. */
  rdApiKey: string | null;
  /** TMDB API key used to enrich metas; null disables enrichment. */
  tmdbApiKey: string | null;
  /** Base URL of the Zilean search index; null disables Zilean. */
  zileanUrl: string | null;
  /** X-API-KEY for Zilean's authenticated endpoints (checkcached). */
  zileanApiKey: string | null;
  /** Base URL of the Torznab search index; null disables Torznab. */
  torznabUrl: string | null;
  /** API key for the Torznab index. */
  torznabApiKey: string | null;
  /** TTL in seconds for in-memory response caches. */
  cacheTtlSeconds: number;
  /** Whether to include search results not yet cached on the debrid. */
  includeUncached: boolean;
  /** Minimum resolution label (e.g. "1080p") below which results are dropped. */
  minQuality: string | null;
  /** Source/quality tokens to exclude (e.g. ["hdcam", "cam"]). */
  excludeQuality: string[];
  /** Whether to expose the library/downloads cloud catalogs. */
  showLibraryCatalogs: boolean;
  /** Whether to expose the search catalog. */
  showSearchCatalogs: boolean;
  /** Whether each HTTP request is logged to stdout (default true). */
  logRequests: boolean;
  /** Stremio addon id used in the manifest. */
  addonId: string;
  /** Addon display name used in the manifest (Real-Debrid variant). */
  addonName: string;
  /** Addon description used in the manifest. */
  addonDescription: string;
  /** Addon version reported in the manifest. */
  version: string;
}
