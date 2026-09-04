import type { EnrichedMeta, ParsedMedia } from '../types.js';
import type { ContentType, Meta, MetaPreview, Video } from '../stremio.js';
import type { TmdbClient } from '../services/tmdb.js';
import type { CacheSet } from '../services/cache.js';
import { normalizeTitle } from './parser.js';

const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'with', 'in', 'on', 'to', 'vs', 'at']);

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

export class MetaService {
  constructor(
    private tmdb: TmdbClient | null,
    private caches: CacheSet,
  ) {}

  placeholderPoster(baseUrl: string): string {
    return `${baseUrl}/static/poster.png`;
  }

  placeholderBackground(baseUrl: string): string {
    return `${baseUrl}/static/background.png`;
  }

  /** Series need episode metadata: a torrent index often only describes packs. */
  async seriesMeta(title: string, year?: number, imdbId?: string): Promise<Meta | null> {
    const key = `series-episodes:${normalizeTitle(title)}:${year ?? ''}`;
    const cached = this.caches.tmdb.get(key) as Meta | undefined;
    if (cached) return cached;
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
      if (meta) this.caches.tmdb.set(key, meta);
      return meta;
    } catch {
      return null; // Indexed episodes remain usable when metadata is unavailable.
    }
  }

  private async cinemetaById(ttId: string, type: ContentType): Promise<EnrichedMeta | null> {
    const cacheKey = `cinemeta-meta:${ttId}`;
    const cached = this.caches.tmdb.get(cacheKey) as EnrichedMeta | undefined;
    if (cached) return cached;
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`);
      if (!res.ok) return null;
      const m = (await res.json()) as { meta?: { name?: string; poster?: string | null; background?: string | null; year?: string | number; releaseInfo?: string; description?: string } };
      const meta = m.meta;
      if (!meta?.name) return null;
      const rawYear = meta.year ?? meta.releaseInfo;
      const yearMatch = String(rawYear ?? '').match(/(19|20)\d{2}/);
      const out: EnrichedMeta = {
        name: meta.name,
        poster: meta.poster ?? null,
        background: meta.background ?? null,
        year: yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined,
        description: meta.description,
      };
      this.caches.tmdb.set(cacheKey, out);
      return out;
    } catch {
      return null;
    }
  }

  private async cinemetaByTitle(title: string, type: ContentType, year?: number): Promise<EnrichedMeta | null> {
    const cacheKey = `cinemeta-search:${type}:${title.toLowerCase()}:${year ?? ''}`;
    const cached = this.caches.tmdb.get(cacheKey) as EnrichedMeta | undefined;
    if (cached) return cached;
    try {
      const query = encodeURIComponent(title);
      const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${query}.json`);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        metas?: Array<{ id: string; name?: string; poster?: string | null; background?: string | null; releaseInfo?: string }>;
      };
      const metas = data.metas ?? [];
      if (metas.length === 0) return null;
      const pick = metas.find(m => normalizeTitle(m.name ?? '') === normalizeTitle(title)
        && (!year || !m.releaseInfo || m.releaseInfo.match(/\d{4}/)?.[0] === String(year)));
      if (!pick?.name) return null;
      const out: EnrichedMeta = {
        name: pick.name,
        poster: pick.poster ?? null,
        background: pick.background ?? null,
        year: year,
      };
      this.caches.tmdb.set(cacheKey, out);
      return out;
    } catch {
      return null;
    }
  }

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

  private displayName(enriched: EnrichedMeta | null, parsedTitle: string, labelSuffix?: string): string {
    const base = enriched?.name?.trim() ? enriched.name : titleCase(parsedTitle);
    return labelSuffix ? `${base} · ${labelSuffix}` : base;
  }

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
