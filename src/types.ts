// Shared domain types for the Tube addon.

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
  source: 'zilean' | 'torznab' | 'piratebay';
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

export interface TorrentProvider {
  name: string;
  search(query: string): Promise<TorrentResult[]>;
  /** Optional: which of the given hashes the index says are cached on a debrid. */
  checkCached?(hashes: string[]): Promise<Set<string>>;
}

export interface Config {
  port: number;
  /** Override the Real-Debrid API base URL (for tests/mocks). */
  rdApiBase: string | null;
  torboxApiBase: string | null;
  /** Writable directory for persisted state (negative cache). */
  dataDir: string;
  baseUrl: string;
  rdApiKey: string | null;
  tmdbApiKey: string | null;
  zileanUrl: string | null;
  /** X-API-KEY for Zilean's authenticated endpoints (checkcached). */
  zileanApiKey: string | null;
  torznabUrl: string | null;
  torznabApiKey: string | null;
  cacheTtlSeconds: number;
  includeUncached: boolean;
  showLibraryCatalogs: boolean;
  showSearchCatalogs: boolean;
  addonId: string;
  addonName: string;
  addonDescription: string;
  version: string;
}
