// Minimal Stremio protocol types (the SDK does not ship type declarations).

export type ContentType = 'movie' | 'series';

export interface MetaPreview {
  id: string;
  type: ContentType;
  name: string;
  poster: string | null;
  posterShape?: 'square' | 'poster' | 'landscape';
  background?: string | null;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface Video {
  id: string;
  title: string;
  released?: string;
  season?: number;
  episode?: number;
  overview?: string;
  thumbnail?: string;
}

export interface Meta extends MetaPreview {
  videos?: Video[];
}

export interface StreamBehaviorHints {
  notWebReady?: boolean;
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
}

export interface Stream {
  url?: string;
  externalUrl?: string;
  name?: string;
  description?: string;
  behaviorHints?: StreamBehaviorHints;
}

export interface StreamResponse {
  streams: Stream[];
}

export interface MetaResponse {
  meta: Meta;
}

export interface CatalogResponse {
  metas: MetaPreview[];
}

export interface CatalogArgs {
  type: ContentType;
  id: string;
  extra?: {
    search?: string;
    skip?: number;
    genre?: string;
  };
}

export interface MetaArgs {
  type: ContentType;
  id: string;
}

export interface StreamArgs {
  type: ContentType;
  id: string;
}
