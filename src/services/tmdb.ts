/**
 * TMDB API client for enriching metas with canonical names, posters, and
 * backdrops. Stateless: MetaService caches its results in `caches.tmdb`, and
 * every lookup returns null rather than throwing, so a missing key or a TMDB
 * outage never breaks metadata/stream delivery.
 */
import type { EnrichedMeta } from '../types.js';
import { normalizeTitle } from '../meta/parser.js';
import { UPSTREAM_TIMEOUT_MS } from '../constants.js';

const BASE = 'https://api.themoviedb.org/3'; // REST API root.
const IMAGE = 'https://image.tmdb.org/t/p'; // Image CDN; append `/{size}{path}`.

/** A TMDB search/find hit; movie and tv fields are mutually exclusive. */
interface TmdbResult {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
}

/** Build an image CDN URL, or null when no poster/backdrop path is present. */
function imageUrl(path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  return `${IMAGE}/${size}${path}`;
}

/**
 * Thin TMDB client. Endpoints used: `GET /find/{imdbId}` (with
 * `external_source=imdb_id`), `GET /search/movie`, and `GET /search/tv`.
 * Results are cached upstream by MetaService, not here.
 */
export class TmdbClient {
  constructor(private apiKey: string) {}

  /**
   * Resolve an IMDb id via `GET /find/{imdbId}`. Prefers the movie result and
   * falls back to tv; returns null on any error or when neither list has a hit.
   */
  async findByIdentifier(imdbId: string): Promise<EnrichedMeta | null> {
    const res = await fetch(
      `${BASE}/find/${imdbId}?external_source=imdb_id&api_key=${this.apiKey}`,
      { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      movie_results?: TmdbResult[];
      tv_results?: TmdbResult[];
    };
    const hit =
      data.movie_results?.[0] ?? data.tv_results?.[0];
    if (!hit) return null;
    return this.toMeta(hit, data.movie_results?.[0] ? 'movie' : 'series');
  }

  /**
   * Search by title via `GET /search/movie` and/or `/search/tv`. Without a
   * `type` it tries movie then tv; a `year` maps to `year` (movies) or
   * `first_air_date_year` (series). Only exact normalized-title matches are
   * accepted, so a wrong-year or same-name duplicate is rejected; null when
   * nothing fits.
   */
  async search(title: string, year?: number, type?: 'movie' | 'series'): Promise<EnrichedMeta | null> {
    const targets: Array<{ path: string; kind: 'movie' | 'series' }> =
      type === 'series'
        ? [{ path: 'search/tv', kind: 'series' }]
        : type === 'movie'
          ? [{ path: 'search/movie', kind: 'movie' }]
          : [
              { path: 'search/movie', kind: 'movie' },
              { path: 'search/tv', kind: 'series' },
            ];

    for (const target of targets) {
      const params = new URLSearchParams({
        query: title,
        api_key: this.apiKey,
      });
      if (target.kind === 'movie' && year) params.set('year', String(year));
      if (target.kind === 'series' && year) params.set('first_air_date_year', String(year));

      const res = await fetch(`${BASE}/${target.path}?${params}`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: TmdbResult[] };
      const hit = data.results?.find(r => {
        const date = target.kind === 'movie' ? r.release_date : r.first_air_date;
        return normalizeTitle(r.title ?? r.name ?? '') === normalizeTitle(title)
          && (!year || !date || date.slice(0, 4) === String(year));
      });
      if (hit) return this.toMeta(hit, target.kind);
    }
    return null;
  }

  /** Map a TMDB hit to {@link EnrichedMeta}, deriving year from the type's date field. */
  private toMeta(hit: TmdbResult, kind: 'movie' | 'series'): EnrichedMeta {
    const year = Number.parseInt(
      (kind === 'movie' ? hit.release_date : hit.first_air_date)?.slice(0, 4) ?? '',
      10,
    );
    return {
      name: hit.title ?? hit.name ?? '',
      poster: imageUrl(hit.poster_path, 'w342'),
      background: imageUrl(hit.backdrop_path, 'w1280'),
      year: Number.isFinite(year) ? year : undefined,
      description: hit.overview,
    };
  }
}
