// YTS (yts.mx) provider: the free JSON movie API. Complements The Pirate Bay
// with dedicated movie coverage, IMDb ids, seeder counts, quality and byte
// sizes. Movies only, so series searches simply contribute no results here.
//
// Follows the same contract as the other providers: never throw on network /
// HTTP / parse errors (return [] and log instead), and bound the request with a
// timeout so a stalled upstream cannot hang the handler.
import type { TorrentProvider, TorrentResult } from '../types.js';

const BASE = 'https://yts.mx/api/v2';

/** One torrent entry inside a movie's `torrents` array. */
interface YtsTorrent {
  hash?: string;
  quality?: string;
  seeds?: number;
  peers?: number;
  size?: string;
  size_bytes?: number;
}

/** One movie in `data.movies`. */
interface YtsMovie {
  imdb_code?: string;
  title?: string;
  title_long?: string;
  year?: number;
  torrents?: YtsTorrent[];
}

/** `list_movies.json` envelope. */
interface YtsResponse {
  status?: string;
  data?: { movies?: YtsMovie[] } | null;
}

/** Map one YTS torrent to a {@link TorrentResult}; null when it has no hash. */
function toResult(movie: YtsMovie, t: YtsTorrent): TorrentResult | null {
  if (!t.hash) return null;
  const title = movie.title ?? movie.title_long ?? t.hash;
  return {
    infoHash: t.hash.toLowerCase(),
    title,
    quality: t.quality,
    year: movie.year,
    isSeries: false,
    imdbId: movie.imdb_code && /^tt\d+$/.test(movie.imdb_code) ? movie.imdb_code : undefined,
    seeders: typeof t.seeds === 'number' ? t.seeds : undefined,
    sizeBytes: typeof t.size_bytes === 'number' && t.size_bytes > 0 ? t.size_bytes : undefined,
    sizeLabel: typeof t.size === 'string' ? t.size : undefined,
    raw: movie.title_long ?? movie.title ?? t.hash,
    source: 'yts',
  };
}

/**
 * YTS client. Endpoint: `GET /list_movies.json?query_term=…&limit=50`. A movie
 * may carry several torrents (one per quality), so each is emitted as its own
 * result — the rest of the pipeline already dedupes/ranks by quality.
 */
export class YtsProvider implements TorrentProvider {
  name = 'yts';

  async search(query: string): Promise<TorrentResult[]> {
    let res: Response;
    try {
      const params = new URLSearchParams({ query_term: query, limit: '50' });
      res = await fetch(`${BASE}/list_movies.json?${params}`, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      console.warn(`[yts] request failed for "${query}":`, err instanceof Error ? err.message : err);
      return [];
    }
    if (!res.ok) {
      console.warn(`[yts] HTTP ${res.status} for "${query}"`);
      return [];
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      console.warn(`[yts] non-JSON response for "${query}"`);
      return [];
    }
    const envelope = data as YtsResponse | null;
    if (!envelope || envelope.status !== 'ok') return [];
    const movies = envelope.data?.movies;
    if (!Array.isArray(movies)) return [];

    const out: TorrentResult[] = [];
    for (const movie of movies) {
      for (const t of movie.torrents ?? []) {
        const r = toResult(movie, t);
        if (r) out.push(r);
      }
    }
    return out;
  }
}
