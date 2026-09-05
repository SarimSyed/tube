// Minimal Stremio protocol types (the SDK does not ship type declarations).

/** Movie or series content type. */
export type ContentType = 'movie' | 'series';

/** Base catalog/detail metadata shared by previews and full metas. */
export interface MetaPreview {
  /** Stremio meta id, normally an IMDb `tt` id (or an addon `rd:`/`sr:` id). */
  id: string;
  /** Movie or series. */
  type: ContentType;
  /** Display title. */
  name: string;
  /** Poster image URL. */
  poster: string | null;
  /** Aspect-ratio hint used to render the poster. */
  posterShape?: 'square' | 'poster' | 'landscape';
  /** Backdrop image URL. */
  background?: string | null;
  /** Synopsis. */
  description?: string;
  /** Short release info line (year, air date, etc.). */
  releaseInfo?: string;
  /** IMDb rating string, e.g. "8.7". */
  imdbRating?: string;
  /** Genre labels. */
  genres?: string[];
}

/** A single episode/video within a series meta. */
export interface Video {
  /** Episode id, typically `<imdbId>:<season>:<episode>`. */
  id: string;
  /** Episode title. */
  title: string;
  /** Release date. */
  released?: string;
  /** Season number. */
  season?: number;
  /** Episode number. */
  episode?: number;
  /** Episode synopsis. */
  overview?: string;
  /** Episode thumbnail URL. */
  thumbnail?: string;
}

/** Full meta detail; extends the preview with episode listings. */
export interface Meta extends MetaPreview {
  videos?: Video[];
}

/** Hints telling Stremio how to handle a stream. */
export interface StreamBehaviorHints {
  /** True when the URL is not playable in a web player. */
  notWebReady?: boolean;
  /** Groups episodes into a binge session. */
  bingeGroup?: string;
  /** Filename used for display / downloads. */
  filename?: string;
  /** Stream size in bytes. */
  videoSize?: number;
}

/** A single playable stream option. */
export interface Stream {
  /** Direct stream URL (points at the debrid provider). */
  url?: string;
  /** URL to open externally instead of playing inline. */
  externalUrl?: string;
  /** Stream label. */
  name?: string;
  /** Stream description (quality, size, etc.). */
  description?: string;
  behaviorHints?: StreamBehaviorHints;
}

/** `stream` resource response. */
export interface StreamResponse {
  streams: Stream[];
}

/** `meta` resource response. */
export interface MetaResponse {
  meta: Meta;
}

/** `catalog` resource response. */
export interface CatalogResponse {
  metas: MetaPreview[];
}

/** Arguments Stremio passes to a `catalog` handler. */
export interface CatalogArgs {
  type: ContentType;
  /** Catalog id (e.g. the addon's search/library catalog ids). */
  id: string;
  /** Optional search/pagination parameters passed via the `extra` query param. */
  extra?: {
    search?: string;
    skip?: number;
    genre?: string;
  };
}

/** Arguments Stremio passes to a `meta` handler. */
export interface MetaArgs {
  type: ContentType;
  id: string;
}

/** Arguments Stremio passes to a `stream` handler. */
export interface StreamArgs {
  type: ContentType;
  id: string;
}
