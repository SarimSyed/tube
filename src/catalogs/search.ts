// Stremio catalog handler for the advanced torrent search: groups index
// results into one title card per match, with releases in the stream picker.

import type { TorrentResult } from '../types.js';
import type { CatalogResponse, ContentType, Meta } from '../stremio.js';
import { MetaService } from '../meta/meta.js';
import { SearchService, sameTitle } from '../services/search.js';
import { searchId, parseSearchId, parseSearchContext } from '../id.js';
import { mapLimit } from '../util.js';
import type { RdGateway } from '../services/realdebrid.js';
import type { CacheSet } from '../services/cache.js';
import { PAGE_SIZE } from '../constants.js';

/**
 * Serves the `rd-search` catalog. One meta card is produced per distinct title
 * (deduped via `sameTitle`), with the actual releases exposed later through the
 * stream picker keyed by the `sr:` info-hash ids.
 */
export class SearchCatalog {
  constructor(
    private rd: RdGateway,
    private searchService: SearchService,
    private metaService: MetaService,
    private caches: CacheSet,
    private includeUncached: boolean,
  ) {}

  /**
   * Run a torrent search for `query` and return a page of title cards. Results
   * are gated on RD instant-availability (unless unavailable or
   * `includeUncached` is set), cached copies are floated to the top with a
   * stable sort, and duplicate titles are collapsed to one card.
   */
  async catalog(type: ContentType, query: string | undefined, baseUrl: string): Promise<CatalogResponse> {
    if (!query || !query.trim()) return { metas: [] };

    const results = await this.searchService.search(query, type);
    if (results.length === 0) {
      console.warn(`[search] no index results for "${query}" (${type})`);
      return { metas: [] };
    }

    const hashes = [...new Set(results.map((r) => r.infoHash))];
    // Availability may be unknown when RD disabled the instant-availability
    // endpoint for this account; then show results ungated.
    let cachedHashes: Set<string> | null = null;
    try {
      cachedHashes = await this.rd.instantAvailability(hashes);
    } catch (err) {
      console.warn('[search] instant-availability check failed, showing ungated results:', err instanceof Error ? err.message : err);
      cachedHashes = null;
    }
    const availabilityKnown = cachedHashes !== null;

    const scored = results
      .map((r) => {
        const cached = availabilityKnown ? (cachedHashes as Set<string>).has(r.infoHash) : true;
        return { r, cached, unknown: !availabilityKnown };
      })
      .filter((x) => this.includeUncached || x.unknown || x.cached)
      .sort((a, b) => {
        // Stable sort: float cached copies to the top, otherwise keep the
        // query-relevance order already applied by SearchService.
        if (a.cached !== b.cached) return a.cached ? -1 : 1;
        return 0;
      });

    // One title card; individual releases belong in the stream picker.
    const grouped = scored.filter((x, i) => !scored.slice(0, i).some(y => sameTitle(x.r, y.r))).slice(0, PAGE_SIZE);

    const metas = await mapLimit(grouped, 6, async ({ r }) => {
      this.caches.search.set(`result:${r.infoHash}`, r);
      return this.metaService.preview({
        id: searchId(r.infoHash, r),
        type,
        title: r.title,
        year: r.year,
        imdbId: r.imdbId,
        baseUrl,
      });
    });
    return { metas };
  }

  /**
   * Build the full `Meta` for a search result. The context embedded in the
   * `sr:` id is used when available (so bookmarks survive a cache restart),
   * falling back to the search cache. Series cards prefer canonical Cinemeta
   * episodes via `seriesMeta`; otherwise same-title results are merged and
   * sorted into episode/season-pack videos.
   */
  async meta(id: string, baseUrl: string): Promise<Meta | null> {
    const hash = parseSearchId(id);
    if (!hash) return null;
    const result = parseSearchContext(id) ?? this.caches.search.get(`result:${hash}`) as TorrentResult | undefined;

    const title = result?.title ?? hash;
    const type: ContentType = result?.isSeries ? 'series' : 'movie';
    let episodes: TorrentResult[] = result ? [result] : [];
    if (result?.isSeries) {
      const canonical = await this.metaService.seriesMeta(result.title, result.year, result.imdbId);
      if (canonical) return { ...canonical, id };
      const found = await this.searchService.search(result.title, 'series');
      episodes = [result, ...found.filter(r => sameTitle(result, r))]
        .filter((r, i, all) => all.findIndex(other => other.season === r.season && other.episode === r.episode) === i)
        .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    }

    return this.metaService.fullMeta({
      id,
      type,
      title,
      year: result?.year,
      imdbId: result?.imdbId,
      baseUrl,
      videos: type === 'series'
        ? episodes.map(r => ({
            id: searchId(r.infoHash, r),
            title: r.episode !== undefined ? `Episode ${r.episode}` : r.season !== undefined ? `Season ${r.season} pack` : r.title,
            season: r.season, episode: r.episode,
          }))
        : undefined,
    });
  }
}
