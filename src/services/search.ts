/**
 * SearchService: orchestrates the TorrentProviders. Fans a query out to every
 * source, tolerates partial failures, dedupes by info_hash, filters to the
 * requested title/type, and re-ranks by query relevance before caching.
 */
import type { TorrentProvider, TorrentResult } from '../types.js';
import type { ContentType } from '../stremio.js';
import type { CacheSet } from './cache.js';
import { normalizeTitle } from '../meta/parser.js';

/** Split + normalize a title into its word tokens for fuzzy title matching. */
export function normTokens(text: string): Set<string> {
  return new Set(
    normalizeTitle(text)
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Whether two results refer to the same title. IMDb ids win when both are
 * present; otherwise normalized title + year must match, and movie/series must
 * agree.
 */
export function sameTitle(a: TorrentResult, b: TorrentResult): boolean {
  if (a.isSeries !== b.isSeries) return false;
  if (a.imdbId && b.imdbId) return a.imdbId === b.imdbId;
  return normalizeTitle(a.title) === normalizeTitle(b.title) && a.year === b.year;
}

/**
 * Score how well a result's title matches the user's query. Favors titles that
 * cover all query tokens and contain few extras (so "empire strikes back" ranks
 * "The Empire Strikes Back" above "Pokemon Mewtwo Strikes Back Evolution").
 */
export function rankByRelevance(result: TorrentResult, query: string): number {
  const q = normTokens(query);
  if (q.size === 0) return 0;
  const t = normTokens(result.title);
  let hits = 0;
  for (const tok of t) if (q.has(tok)) hits += 1;
  const coverage = hits / q.size;
  const precision = t.size > 0 ? hits / t.size : 0;
  return coverage * 2 + precision;
}

/**
 * Multi-source search. Combines provider results, dedupes by info_hash, filters
 * by query title + requested type, and re-ranks by relevance. Results are
 * cached under `type:query` in `caches.search`.
 */
export class SearchService {
  constructor(
    private providers: TorrentProvider[],
    private caches: CacheSet,
  ) {}

  /** Keep one result per info_hash, preferring the copy that carries an IMDb id. */
  private dedupe(results: TorrentResult[]): TorrentResult[] {
    const seen = new Map<string, TorrentResult>();
    for (const r of results) {
      const existing = seen.get(r.infoHash);
      if (!existing) {
        seen.set(r.infoHash, r);
      } else if (!existing.imdbId && r.imdbId) {
        seen.set(r.infoHash, r);
      }
    }
    return [...seen.values()];
  }

  /** Union of hashes the providers report as cached (empty when unavailable). */
  async checkCached(hashes: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (hashes.length === 0) return out;
    for (const p of this.providers) {
      if (!p.checkCached) continue;
      try {
        const set = await p.checkCached(hashes);
        for (const h of set) out.add(h);
      } catch {
        // ignore provider errors
      }
    }
    return out;
  }

  /**
   * Search all providers and shape the combined results. Steps: trim/empty
   * guard → cache lookup → fan out via `Promise.allSettled` (partial failures
   * ignored) → dedupe → title-token filter (unless `skipTitleFilter`) →
   * series/movie filter → sort by query relevance → cache + return.
   */
  async search(
    query: string,
    type: ContentType,
    opts: { skipTitleFilter?: boolean } = {},
  ): Promise<TorrentResult[]> {
    const normalized = query.trim();
    if (!normalized) return [];

    const cacheKey = `${type}:${normalized.toLowerCase()}`;
    const cached = this.caches.search.get(cacheKey) as TorrentResult[] | undefined;
    if (cached) return cached;

    const settled = await Promise.allSettled(
      this.providers.map((p) => p.search(normalized)),
    );
    const combined: TorrentResult[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') combined.push(...s.value);
    }

    const queryTokens = [...normTokens(normalized)];
    // Keep only results whose title covers every query token (prefix match, a
    // loose word-boundary check), then restrict to the requested type.
    const deduped = this.dedupe(combined).filter(r => {
      if (opts.skipTitleFilter) return true;
      // Include the year so a "Matrix 1999" query can also match on it.
      const titleTokens = [...normTokens(`${r.title} ${r.year ?? ''}`)];
      return queryTokens.every(q => titleTokens.some(t => t.startsWith(q)));
    }).filter((r) =>
      type === 'series' ? r.isSeries : !r.isSeries,
    );

    // Re-rank by query relevance (provider order can be poor).
    const ranked = deduped.sort(
      (a, b) => rankByRelevance(b, normalized) - rankByRelevance(a, normalized),
    );

    this.caches.search.set(cacheKey, ranked);
    return ranked;
  }
}
