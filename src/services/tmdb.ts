import type { EnrichedMeta } from '../types.js';
import { normalizeTitle } from '../meta/parser.js';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p';

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

function imageUrl(path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  return `${IMAGE}/${size}${path}`;
}

export class TmdbClient {
  constructor(private apiKey: string) {}

  async findByIdentifier(imdbId: string): Promise<EnrichedMeta | null> {
    const res = await fetch(
      `${BASE}/find/${imdbId}?external_source=imdb_id&api_key=${this.apiKey}`,
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

      const res = await fetch(`${BASE}/${target.path}?${params}`);
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
