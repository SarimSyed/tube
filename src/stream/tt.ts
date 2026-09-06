/**
 * Standard Cinemeta title/episode stream resolution.
 *
 * Given a Cinemeta `tt…` id (optionally `tt…:season:episode`), finds matching
 * releases already in the user's debrid cloud, then tops up from the torrent
 * index via bounded cache-probing. Video never passes through the addon — the
 * returned stream URLs point straight at the debrid provider.
 */
import type { RdGateway } from '../services/realdebrid.js';
import type { CacheSet } from '../services/cache.js';
import type { SearchService } from '../services/search.js';
import type { NegativeStore } from '../services/negativeStore.js';
import type { ContentType, Stream, StreamResponse } from '../stremio.js';
import type { RdTorrentSummary, TorrentResult } from '../types.js';
import { normalizeTitle, parseFilename } from '../meta/parser.js';
import { mapLimit } from '../util.js';
import { torrentStreams } from './resolver.js';
import { findCachedStreams, compareStreamCandidates } from './cacheProbe.js';
import { CINEMETA_TIMEOUT_MS } from '../constants.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';

interface CinemetaMeta {
  meta: { id: string; type: string; name?: string; year?: string | number; releaseInfo?: string };
}

/** Lowercase and collapse non-alphanumerics so titles compare on words only. */
function cleanTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Like {@link cleanTitle}, then drops a leading "the/a/an" article. */
function normTitle(title: string): string {
  const cleaned = cleanTitle(title);
  return cleaned.replace(/^(the|a|an)\s+/, '');
}

/** Dice coefficient over character bigrams — catches UK/US spelling etc. */
function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    if (s.length < 2) {
      out.add(s);
      return out;
    }
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

/** Bigram similarity at or above this is treated as the same title. */
const TITLE_SIMILARITY_THRESHOLD = 0.9;
/** Aim to return up to this many total streams (cloud + index). */
const STREAM_TARGET = 30;
/** Cap on matching cloud torrents expanded per request. */
const CLOUD_MATCH_LIMIT = 6;
/** Concurrency when expanding cloud torrents (RD round-trips overlap). */
const CLOUD_EXPAND_CONCURRENCY = 4;

interface YearOk {
  torrentYear?: number;
  metaYear?: number;
}

/** True when either year is unknown or they are equal — a missing year never blocks a match. */
function yearsMatch({ torrentYear, metaYear }: YearOk): boolean {
  if (torrentYear === undefined || metaYear === undefined) return true;
  return torrentYear === metaYear;
}

/**
 * The "standard title/episode" stream provider. Resolves a Cinemeta `tt…` id
 * by matching the title against releases already in the user's debrid cloud
 * (instant, no probing), then topping up from torrent-index results via
 * cache-probing. Emits one `Stream` per playable file — cloud results first,
 * deduped by URL, and capped at `STREAM_TARGET`.
 */
/** Optional dependencies and preferences for {@link TtStreamProvider}. */
export interface TtStreamOptions {
  /** Torrent-index search; when null, only cloud results are returned. */
  search?: SearchService | null;
  /** Persistent blocked-hash set; when null, negatives fall back to the `misc` cache. */
  negatives?: NegativeStore | null;
  /** Languages floated to the top and searched for explicitly. */
  preferredLanguages?: string[];
  /** Quality preferences: minimum resolution and source tokens to exclude. */
  qualityFilters?: { minQuality?: string; excludeQuality?: string[] };
}

export class TtStreamProvider {
  private search: SearchService | null;
  private negativesStore: NegativeStore | null;
  private preferredLanguages: string[];
  private qualityFilters: { minQuality?: string; excludeQuality?: string[] };

  /**
   * @param rd Debrid gateway (Real-Debrid or TorBox) for cloud queries and probing.
   * @param caches TTL caches — `tmdb` for Cinemeta metadata, `misc` for the negative-hash set.
   * @param options Optional services and preferences (search, negatives, languages, quality).
   */
  constructor(
    private rd: RdGateway,
    private caches: CacheSet,
    options: TtStreamOptions = {},
  ) {
    this.search = options.search ?? null;
    this.negativesStore = options.negatives ?? null;
    this.preferredLanguages = options.preferredLanguages ?? [];
    this.qualityFilters = options.qualityFilters ?? {};
  }

  /** Fetch this id's name/year from Cinemeta, cached in the `tmdb` TTL cache. */
  private async cinemetaMeta(type: ContentType, ttId: string): Promise<{ name: string; year?: number } | null> {
    const cacheKey = `cinemeta:${ttId}`;
    const cached = this.caches.tmdb.get(cacheKey) as { name: string; year?: number } | undefined;
    if (cached) return cached;

    try {
      const res = await fetch(`${CINEMETA}/meta/${type}/${ttId}.json`, { signal: AbortSignal.timeout(CINEMETA_TIMEOUT_MS) });
      if (!res.ok) return null;
      const data = (await res.json()) as CinemetaMeta;
      const m = data.meta;
      if (!m || !m.name) return null;
      const rawYear = m.year ?? m.releaseInfo;
      const yearMatch = String(rawYear ?? '').match(/(19|20)\d{2}/);
      const result = { name: m.name, year: yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined };
      this.caches.tmdb.set(cacheKey, result);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Streams for a normal Cinemeta id (`tt…` or `tt…:season:episode`), matched
   * first against torrents already in the user's RD cloud (instant, since only
   * downloaded torrents have playable links), then topped up from the index.
   * Results are deduped by URL and capped at `STREAM_TARGET`.
   */
  async resolve(type: ContentType, id: string): Promise<StreamResponse> {
    const parts = id.split(':');
    const ttId = parts[0];
    if (!/^tt\d+$/.test(ttId)) return { streams: [] };
    const season = parts.length >= 3 ? Number.parseInt(parts[1], 10) : undefined;
    const episode = parts.length >= 3 ? Number.parseInt(parts[2], 10) : undefined;

    const meta = await this.cinemetaMeta(type, ttId);
    if (!meta) return { streams: [] };

    let torrents;
    try {
      torrents = await this.rd.listTorrents();
    } catch {
      return { streams: [] };
    }

    const streams: Stream[] = [];
    const seenUrls = new Set<string>();

    // Collect the matching downloaded torrents first (pure list filtering, no
    // I/O), then expand them concurrently so the per-torrent RD round-trips
    // (info + unrestrict) overlap instead of serializing.
    const matches: RdTorrentSummary[] = [];
    for (const t of torrents) {
      if (matches.length >= CLOUD_MATCH_LIMIT) break;
      const p = parseFilename(t.filename);
      if (!p.title) continue;
      const torrentNorm = normTitle(p.title);
      const targetNorm = normTitle(meta.name);
      const titleMatches =
        torrentNorm === targetNorm ||
        (bigramSimilarity(torrentNorm, targetNorm) >= TITLE_SIMILARITY_THRESHOLD &&
          yearsMatch({ torrentYear: p.year, metaYear: meta.year }));
      if (!titleMatches) continue;

      if (type === 'movie') {
        if (p.isSeries) continue;
        if (!yearsMatch({ torrentYear: p.year, metaYear: meta.year })) continue;
      } else {
        if (!p.isSeries) continue;
        if (season !== undefined && p.season !== undefined && p.season !== season) continue;
        if (episode !== undefined && p.episode !== undefined && p.episode !== episode) continue;
      }

      // Only downloaded torrents have playable links.
      if (t.status !== 'downloaded') continue;
      matches.push(t);
    }

    const expanded = await mapLimit(matches, CLOUD_EXPAND_CONCURRENCY, async (t): Promise<Stream[]> => {
      let info;
      try {
        info = await this.rd.getTorrentInfo(t.id);
      } catch {
        return [];
      }
      if (!info || info.status !== 'downloaded') return [];
      try {
        return await torrentStreams(this.rd, info, season, episode);
      } catch {
        return [];
      }
    });

    for (const list of expanded) {
      if (streams.length >= STREAM_TARGET) break;
      for (const s of list) {
        if (!s.url || seenUrls.has(s.url)) continue;
        seenUrls.add(s.url);
        streams.push(s);
        if (streams.length >= STREAM_TARGET) break;
      }
    }

    // Cloud streams come first; if we still have room, top up from the index so a
    // title with a single cloud copy still surfaces its other cached releases.
    if (this.search && streams.length < STREAM_TARGET) {
      const found = await this.searchAndAdd(type, meta.name, meta.year, season, episode);
      streams.push(...found);
    }

    // Dedupe by URL (cloud and index may both surface the same torrent) and cap.
    const seen = new Set<string>();
    const deduped = streams.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
    return { streams: deduped.slice(0, STREAM_TARGET) };
  }

  /**
   * Rank an index result for this request: exact year match (+4), series/movie
   * kind agreement (+1), matching season/episode (+2 each, −1 for a known
   * mismatch), plus size/TB as a tie-break towards larger releases.
   */
  private scoreCandidate(r: TorrentResult, type: ContentType, metaYear: number | undefined, season?: number, episode?: number): number {
    let score = r.year === metaYear ? 4 : 0;
    if (r.isSeries === (type === 'series')) score += 1;
    if (season !== undefined && r.season !== undefined) {
      score += r.season === season ? 2 : -1;
    }
    if (episode !== undefined && r.episode !== undefined) {
      score += r.episode === episode ? 2 : -1;
    }
    score += (r.sizeBytes ?? 0) / 1_000_000_000_000; // tie-break towards larger files
    return score;
  }

  /**
   * Search the index for `name`, then probe the ranked candidates against the
   * debrid and return the cached ones as streams. Also searches each preferred
   * language explicitly for dubbed releases a plain title search misses,
   * prefilters to index-known-cached hashes when available (avoiding
   * add-throttling), and persists any newly blocked hashes via the negatives
   * store.
   */
  private async searchAndAdd(
    type: ContentType,
    name: string,
    metaYear: number | undefined,
    season?: number,
    episode?: number,
  ): Promise<Stream[]> {
    if (!this.search) return [];
    let results: TorrentResult[] = [];
    try {
      results = await this.search.search(name, type);
    } catch {
      results = [];
    }

    // Also search each prioritized language explicitly so dubbed releases that a
    // plain title search misses (e.g. "Dune Part One Hindi") still surface.
    const preferred = this.preferredLanguages.length ? this.preferredLanguages : [];
    if (preferred.length) {
      const extra: TorrentResult[] = [];
      for (const lang of preferred) {
        try {
          const found = await this.search.search(`${name} ${lang}`, type, { skipTitleFilter: true });
          for (const r of found) {
            if (normalizeTitle(r.title) === normalizeTitle(name) &&
                (type !== 'movie' || yearsMatch({ torrentYear: r.year, metaYear }))) {
              extra.push(r);
            }
          }
        } catch {
          // ignore a failed language search
        }
      }
      const seen = new Set(extra.map((r) => r.infoHash));
      results = [...extra, ...results.filter((r) => !seen.has(r.infoHash))];
    }

    if (results.length === 0) return [];

    // Best candidates first, then probe each against RD: cached ones stream
    // instantly, uncached ones are removed again so the account stays clean.
    // Rank by title/episode correctness first, then break ties with the shared
    // quality→seeders→size→language hierarchy.
    const ranked = [...results].sort((a, b) => {
      const byScore =
        this.scoreCandidate(b, type, metaYear, season, episode) -
        this.scoreCandidate(a, type, metaYear, season, episode);
      if (byScore !== 0) return byScore;
      return compareStreamCandidates(a, b, preferred);
    });
    let candidates = ranked;
    // Prefilter to releases the debrid already has cached so we only add
    // torrents that resolve instantly — this is what keeps Tube as fast as
    // Torrentio/Comet instead of add+poll+delete probing every uncached hit.
    // Real-Debrid's own availability endpoint is authoritative (and TTL-cached);
    // the index's cached hints (DMM hashlist) are the fallback when the endpoint
    // is unavailable. TorBox filters candidates itself inside findCachedStreams.
    try {
      if (this.rd.provider !== 'torbox') {
        let cached: Set<string> | null = null;
        try {
          cached = await this.rd.instantAvailability(ranked.map((r) => r.infoHash));
        } catch {
          cached = null; // availability endpoint failed/disabled — use index hints
        }
        if (cached === null || cached.size === 0) {
          const hinted = await this.search.checkCached(ranked.map((r) => r.infoHash));
          if (hinted.size > 0) cached = hinted;
        }
        if (cached !== null && cached.size > 0) {
          const cachedSet = cached;
          candidates = ranked.filter((r) => cachedSet.has(r.infoHash));
        }
      }
    } catch {
      // Unknown cache state — fall through to probing everything.
    }
    if (candidates.length === 0) {
      console.warn(`[tt] no cached candidates remain for "${name}" after the availability check`);
      return [];
    }
    const negKey = 'probe-neg';
    const negatives = this.negativesStore
      ? this.negativesStore.get()
      : (this.caches.misc.get(negKey) as Set<string> | undefined) ?? new Set<string>();
    console.warn(`[tt] probing ${candidates.length} cached candidate(s) for "${name}"`);
    try {
      const streams = await findCachedStreams(this.rd, candidates, {
        season, episode, negatives,
        preferredLanguages: this.preferredLanguages.length ? this.preferredLanguages : undefined,
        minQuality: this.qualityFilters.minQuality,
        excludeQuality: this.qualityFilters.excludeQuality,
        canDownload: r => normalizeTitle(r.title) === normalizeTitle(name)
          && r.isSeries === (type === 'series')
          && (type !== 'movie' || yearsMatch({ torrentYear: r.year, metaYear }))
          && (season === undefined || r.season === undefined || r.season === season)
          && (episode === undefined || r.episode === undefined || r.episode === episode),
      });
      // Binge-watching support: when this series episode was itself queued as an
      // uncached download (a status entry has no playable url), also queue E+1.
      if (type === 'series' && this.rd.allowUncached && streams.some((s) => !s.url)) {
        await this.queueNextEpisode(results, season, episode);
      }
      if (this.negativesStore) this.negativesStore.saveSoon();
      else this.caches.misc.set(negKey, negatives);
      return streams;
    } catch (err) {
      console.warn('[tt] index probe failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Queue the next episode (SxE+1) of a series while the user binge-watches.
   * Reuses the same add-magnet path (and its in-flight dedup) as the normal
   * uncached flow; skips anything already in the cloud and never fires for
   * movies or when downloads are off. Best-effort: a failure is only logged.
   */
  private async queueNextEpisode(results: TorrentResult[], season?: number, episode?: number): Promise<void> {
    if (season === undefined || episode === undefined) return;
    const next = episode + 1;
    const preferred = this.preferredLanguages.length ? this.preferredLanguages : undefined;
    const candidates = results
      .filter((r) => r.isSeries && r.season === season && r.episode === next && r.infoHash)
      .sort((a, b) => compareStreamCandidates(a, b, preferred));
    if (candidates.length === 0) return;

    let existing = new Set<string>();
    try {
      existing = new Set((await this.rd.listTorrents()).map((t) => t.hash.toLowerCase()));
    } catch {
      // Unknown cloud state — still safe to proceed; addMagnet dedups in-flight.
    }
    const pick = candidates.find((r) => !existing.has(r.infoHash)) ?? candidates[0];
    if (!pick || existing.has(pick.infoHash)) return;

    try {
      await this.rd.addMagnet(`magnet:?xt=urn:btih:${pick.infoHash}`, false);
      console.log(`[tt] prefetched next episode S${String(season).padStart(2, '0')}E${String(next).padStart(2, '0')} (${pick.infoHash.slice(0, 8)}…)`);
    } catch (err) {
      console.warn('[tt] next-episode prefetch failed:', err instanceof Error ? err.message : String(err));
    }
  }
}
