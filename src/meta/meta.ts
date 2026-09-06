// Builds Stremio meta cards (MetaPreview / Meta) from parsed torrent/library
// data, enriching titles and artwork via TMDB with a free Cinemeta fallback.

import type { EnrichedMeta, ParsedMedia } from '../types.js';
import type { ContentType, Meta, MetaPreview, Video } from '../stremio.js';
import type { TmdbClient } from '../services/tmdb.js';
import type { CacheSet } from '../services/cache.js';
import { normalizeTitle } from './parser.js';
import { singleFlight } from '../util.js';

/** Words kept lowercase when not the first word of a title-cased string. */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'with', 'in', 'on', 'to', 'vs', 'at']);

/**
 * Title-case a name using English conventions: every word capitalized except
 * the small words above when not first. Used when no TMDB/Cinemeta name exists.
 */
export function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Builds Stremio `Meta`/`MetaPreview` cards for parsed media. Enriches names,
 * posters and backgrounds from TMDB when configured, falling back to the free
 * Cinemeta index so covers still appear without a TMDB key. Relies on the
 * addon's self-defined ids (`rd:` / `sr:`, see `id.ts`) for meta/video ids.
 */
export class MetaService {
  constructor(
    private tmdb: TmdbClient | null,
    private caches: CacheSet,
  ) {}

  /** Fallback poster URL used when no TMDB/Cinemeta image is available. */
  placeholderPoster(baseUrl: string): string {
    return `${baseUrl}/static/poster.png`;
  }

  /** Fallback background URL used when no TMDB/Cinemeta image is available. */
  placeholderBackground(baseUrl: string): string {
    return `${baseUrl}/static/background.png`;
  }

  /**
   * Single-flight + TTL-cache wrapper for a metadata network lookup. Returns the
   * cached value when present; otherwise runs `loader` once (concurrent callers
   * for the same key share the in-flight promise) and caches a non-null result.
   * Used by the Cinemeta lookups below so a thundering herd of the same title
   * doesn't duplicate identical upstream requests.
   */
  private async fetchCached<T>(key: string, loader: () => Promise<T | null>): Promise<T | null> {
    const hit = this.caches.tmdb.get(key) as T | undefined;
    if (hit) return hit;
    return singleFlight(key, async () => {
      const again = this.caches.tmdb.get(key) as T | undefined;
      if (again) return again;
      const value = await loader();
      if (value !== null && value !== undefined) this.caches.tmdb.set(key, value);
      return value;
    });
  }

  /**
   * Build a full series `Meta` with per-episode `videos`, sourced from the free
   * Cinemeta index. Torrent indexes often only describe a season pack, so the
   * episode list must come from an external catalog. `imdbId` is used directly
   * when present (the title is still verified to reject wrong-show matches);
   * otherwise the title is searched. Results are cached under a normalized
   * title/year key; returns `null` when nothing is found or Cinemeta is
   * unreachable (callers keep the indexed episodes).
   */
  async seriesMeta(title: string, year?: number, imdbId?: string): Promise<Meta | null> {
    const key = `series-episodes:${normalizeTitle(title)}:${year ?? ''}`;
    const signal = AbortSignal.timeout(8_000);
    const matches = (m: { name?: string; releaseInfo?: string }) =>
      normalizeTitle(m.name ?? '') === normalizeTitle(title)
      && (!year || !m.releaseInfo || m.releaseInfo.match(/\d{4}/)?.[0] === String(year));
    const byId = async (id: string): Promise<Meta | null> => {
      if (!/^tt\d+$/.test(id)) return null;
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/${id}.json`, { signal });
      if (!res.ok) return null;
      const { meta } = await res.json() as { meta?: Meta };
      if (!meta || !matches(meta) || !Array.isArray(meta.videos)) return null;
      const videos = meta.videos.filter(v => Number.isInteger(v.season) && v.season! >= 0
        && Number.isInteger(v.episode) && v.episode! >= 0).map(v => ({
          id: `${id}:${v.season}:${v.episode}`, title: v.title || `Episode ${v.episode}`,
          season: v.season, episode: v.episode,
          released: v.released && Number.isFinite(Date.parse(v.released)) ? v.released : undefined,
        }));
      return videos.length ? { ...meta, id, type: 'series', videos } : null;
    };
    return this.fetchCached(key, async () => {
      try {
        // Index identifiers can point at an unrelated show; verify the title first.
        let meta = imdbId ? await byId(imdbId) : null;
        if (!meta) {
          const res = await fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(title)}.json`, { signal });
          if (!res.ok) return null;
          const { metas } = await res.json() as { metas?: MetaPreview[] };
          const match = metas?.find(matches);
          if (match) meta = await byId(match.id);
        }
        return meta;
      } catch {
        return null; // Indexed episodes remain usable when metadata is unavailable.
      }
    });
  }

  /** Fetch a single Cinemeta card by IMDb id (`tt…`) and cache it. */
  private async cinemetaById(ttId: string, type: ContentType): Promise<EnrichedMeta | null> {
    return this.fetchCached(`cinemeta-meta:${ttId}`, async () => {
      try {
        const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return null;
        const m = (await res.json()) as { meta?: { name?: string; poster?: string | null; background?: string | null; year?: string | number; releaseInfo?: string; description?: string } };
        const meta = m.meta;
        if (!meta?.name) return null;
        const rawYear = meta.year ?? meta.releaseInfo;
        const yearMatch = String(rawYear ?? '').match(/(19|20)\d{2}/);
        return {
          name: meta.name,
          poster: meta.poster ?? null,
          background: meta.background ?? null,
          year: yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined,
          description: meta.description,
        };
      } catch {
        return null;
      }
    });
  }

  /**
   * Search Cinemeta by title (and optional year) and return the first card
   * whose normalized name matches, cached by a title/year key.
   */
  private async cinemetaByTitle(title: string, type: ContentType, year?: number): Promise<EnrichedMeta | null> {
    return this.fetchCached(`cinemeta-search:${type}:${title.toLowerCase()}:${year ?? ''}`, async () => {
      try {
        const query = encodeURIComponent(title);
        const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${query}.json`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          metas?: Array<{ id: string; name?: string; poster?: string | null; background?: string | null; releaseInfo?: string }>;
        };
        const metas = data.metas ?? [];
        if (metas.length === 0) return null;
        const pick = metas.find(m => normalizeTitle(m.name ?? '') === normalizeTitle(title)
          && (!year || !m.releaseInfo || m.releaseInfo.match(/\d{4}/)?.[0] === String(year)));
        if (!pick?.name) return null;
        return {
          name: pick.name,
          poster: pick.poster ?? null,
          background: pick.background ?? null,
          year: year,
        };
      } catch {
        return null;
      }
    });
  }

  /**
   * Enrich a parsed title with metadata. Tries TMDB first (by IMDb id, then
   * search) when a key is configured, then falls back to the free Cinemeta
   * index (by id, then title) so artwork still appears without TMDB. Series
   * matches are title-verified to avoid attaching the wrong show.
   */
  private async enrich(
    parsed: Pick<ParsedMedia, 'title' | 'year'>,
    type: ContentType,
    imdbId?: string,
  ): Promise<EnrichedMeta | null> {
    const matchesSeries = (m: EnrichedMeta) => type !== 'series'
      || normalizeTitle(m.name) === normalizeTitle(parsed.title);
    // 1. TMDB when a key is configured.
    if (this.tmdb) {
      if (imdbId) {
        const cacheKey = `imdb:${imdbId}`;
        const cached = this.caches.tmdb.get(cacheKey) as EnrichedMeta | undefined;
        if (cached && matchesSeries(cached)) return cached;
        const found = await this.tmdb.findByIdentifier(imdbId);
        if (found && matchesSeries(found)) {
          this.caches.tmdb.set(cacheKey, found);
          return found;
        }
      }
      const cacheKey = `${type}:${parsed.title.toLowerCase()}:${parsed.year ?? ''}`;
      const cached = this.caches.tmdb.get(cacheKey) as EnrichedMeta | undefined;
      if (cached) return cached;
      const found = await this.tmdb.search(parsed.title, parsed.year, type);
      if (found) {
        this.caches.tmdb.set(cacheKey, found);
        return found;
      }
    }

    // 2. Free Cinemeta fallback so covers appear even without a TMDB key.
    if (imdbId && /^tt\d+$/.test(imdbId)) {
      const byImdb = await this.cinemetaById(imdbId, type);
      if (byImdb && matchesSeries(byImdb)) return byImdb;
    }
    return this.cinemetaByTitle(parsed.title, type, parsed.year);
  }

  /** Prefer the enriched display name; title-case the parsed title otherwise. */
  private displayName(enriched: EnrichedMeta | null, parsedTitle: string, labelSuffix?: string): string {
    const base = enriched?.name?.trim() ? enriched.name : titleCase(parsedTitle);
    return labelSuffix ? `${base} · ${labelSuffix}` : base;
  }

  /**
   * Build a lightweight `MetaPreview` for catalog listings. Enriches the title,
   * uses TMDB/Cinemeta artwork when available and the static placeholder
   * otherwise, and sets `releaseInfo` to the enriched (or parsed) year.
   */
  async preview(opts: {
    id: string;
    type: ContentType;
    title: string;
    year?: number;
    labelSuffix?: string;
    imdbId?: string;
    baseUrl: string;
  }): Promise<MetaPreview> {
    const enriched = await this.enrich({ title: opts.title, year: opts.year }, opts.type, opts.imdbId);
    return {
      id: opts.id,
      type: opts.type,
      name: this.displayName(enriched, opts.title, opts.labelSuffix),
      poster: enriched?.poster ?? this.placeholderPoster(opts.baseUrl),
      background: enriched?.background ?? null,
      description: enriched?.description,
      releaseInfo: String(enriched?.year ?? opts.year ?? ''),
      genres: undefined,
    };
  }

  /**
   * Build a full `Meta` (used on the detail page) by enriching like `preview`
   * and attaching the given `videos` list (episodes for series, undefined for
   * movies).
   */
  async fullMeta(opts: {
    id: string;
    type: ContentType;
    title: string;
    year?: number;
    imdbId?: string;
    baseUrl: string;
    videos?: Video[];
  }): Promise<Meta> {
    const preview = await this.preview({
      id: opts.id,
      type: opts.type,
      title: opts.title,
      year: opts.year,
      imdbId: opts.imdbId,
      baseUrl: opts.baseUrl,
    });
    return { ...preview, videos: opts.videos };
  }
}
