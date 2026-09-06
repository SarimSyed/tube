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
import { buildDownloadRows } from './downloadRows.js';
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
/** Quality preferences for a request: server defaults + per-install profile. */
export interface QualityFilters {
  /** Drop known resolutions below this (server config). */
  minQuality?: string;
  /** Drop results whose raw name mentions any token (server config). */
  excludeQuality?: string[];
  /** Highest resolution to offer (per-install cap). */
  maxResolution?: string;
  /** Largest file to offer in bytes (per-install cap). */
  maxSizeBytes?: number;
  /** When true, order the final picker smallest-file-first. */
  smallerFirst?: boolean;
}

/** Optional dependencies and preferences for {@link TtStreamProvider}. */
export interface TtStreamOptions {
  /** Torrent-index search; when null, only cloud results are returned. */
  search?: SearchService | null;
  /** Persistent blocked-hash set; when null, negatives fall back to the `misc` cache. */
  negatives?: NegativeStore | null;
  /** Languages floated to the top and searched for explicitly. */
  preferredLanguages?: string[];
  /** Quality preferences: minimum resolution and source tokens to exclude. */
  qualityFilters?: QualityFilters;
  /** Builds the Tube action URL for a "Download (uncached)" row. When omitted,
   * no download rows are offered. */
  downloadActionUrl?: (infoHash: string) => string;
}

export class TtStreamProvider {
  private search: SearchService | null;
  private negativesStore: NegativeStore | null;
  private preferredLanguages: string[];
  private qualityFilters: QualityFilters;
  private downloadActionUrl: ((infoHash: string) => string) | undefined;

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
    this.downloadActionUrl = options.downloadActionUrl;
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

    let torrents: RdTorrentSummary[] = [];
    try {
      torrents = await this.rd.listTorrents();
    } catch (err) {
      // Rate-limited or unreachable cloud: degrade to index-only rather than
      // failing the whole request with no streams.
      console.warn(`[tt] cloud list unavailable (${err instanceof Error ? err.message : String(err)}) — index only`);
    }

    const streams: Stream[] = [];
    const seenUrls = new Set<string>();
    const cloudHashes = new Set(torrents.map((t) => t.hash.toLowerCase()));
    const providerLabel = this.rd.provider === 'torbox' ? 'TorBox' : 'Real-Debrid';
    const dashboardUrl = this.rd.provider === 'torbox' ? 'https://torbox.app/dashboard' : 'https://real-debrid.com/torrents';

    // Single pass over the cloud: download-able matches are expanded (playable
    // now), while matching in-flight torrents (started by an earlier explicit
    // download click) are surfaced as "downloading" status rows. Pure list
    // filtering — no I/O until the concurrent expansion below.
    const matches: RdTorrentSummary[] = [];
    const statusTorrents: RdTorrentSummary[] = [];
    for (const t of torrents) {
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

      if (t.status === 'downloaded') {
        if (matches.length < CLOUD_MATCH_LIMIT) matches.push(t);
      } else if (!['error', 'magnet_error', 'virus', 'dead'].includes(t.status)) {
        if (statusTorrents.length < 3) statusTorrents.push(t);
      }
    }

    // Expand the downloaded matches concurrently so the per-torrent debrid
    // round-trips (info + unrestrict) overlap instead of serializing.
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

    // Status rows: an in-flight cloud torrent the user already asked to download.
    for (const t of statusTorrents) {
      const p = parseFilename(t.filename);
      const quality = p.quality ? ` ${p.quality.toUpperCase()}` : '';
      streams.push({
        name: `${providerLabel} — downloading${quality} ⏳`,
        description: `${t.filename}\nThis torrent is downloading in your ${providerLabel} account.\nOpen the dashboard to check progress, then reopen this title when it finishes.`,
        externalUrl: dashboardUrl,
      });
    }

    // Cloud streams come first; if we still have room, top up from the index so a
    // title with a single cloud copy still surfaces its other cached releases
    // (plus explicit download rows for uncached ones — never auto-started).
    if (this.search && streams.length < STREAM_TARGET) {
      const found = await this.searchAndAdd(type, meta.name, meta.year, season, episode, cloudHashes);
      streams.push(...found);
    }

    // Dedupe playable rows by URL; keep action/status rows (externalUrl only).
    const seen = new Set<string>();
    const deduped = streams.filter((s) => {
      if (s.url) {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
      }
      return true;
    });
    // Data-saver installs list the smallest playable file first.
    if (this.qualityFilters.smallerFirst) {
      deduped.sort(
        (a, b) => (a.behaviorHints?.videoSize ?? Number.MAX_SAFE_INTEGER) - (b.behaviorHints?.videoSize ?? Number.MAX_SAFE_INTEGER),
      );
    }
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
    season: number | undefined,
    episode: number | undefined,
    cloudHashes: Set<string>,
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
    let ranked = [...results].sort((a, b) => {
      const byScore =
        this.scoreCandidate(b, type, metaYear, season, episode) -
        this.scoreCandidate(a, type, metaYear, season, episode);
      if (byScore !== 0) return byScore;
      return compareStreamCandidates(a, b, preferred);
    });

    // A series search returns every release for the whole show (all episodes,
    // packs, language dupes). For a specific episode request, drop anything that
    // cannot deliver it — otherwise we'd probe dozens of unrelated releases and
    // trip the debrid's rate limits. Single-episode matches and same-season
    // packs (which contain the episode) are kept.
    if (type === 'series' && season !== undefined && episode !== undefined) {
      ranked = ranked.filter(
        (r) => r.season === undefined || (r.season === season && (r.episode === undefined || r.episode === episode)),
      );
    }
    if (ranked.length === 0) {
      console.warn(`[tt] no releases for "${name}" match S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
      return [];
    }

    const negKey = 'probe-neg';
    const negatives = this.negativesStore
      ? this.negativesStore.get()
      : (this.caches.misc.get(negKey) as Set<string> | undefined) ?? new Set<string>();
    const preferredList = this.preferredLanguages.length ? this.preferredLanguages : undefined;

    // Split the ranked releases into "playable now" (already cached on the
    // debrid) and "download offers" (uncached). The provider's availability
    // check is authoritative for both providers; when it is unavailable we
    // fall back to the index's cached hints (or probe the ranked list).
    let playable: TorrentResult[] = ranked;
    let uncached: TorrentResult[] = [];
    if (this.rd.provider === 'torbox') {
      try {
        const cached = await this.rd.instantAvailability(ranked.map((r) => r.infoHash));
        if (cached) {
          playable = ranked.filter((r) => cached.has(r.infoHash));
          uncached = ranked.filter((r) => !cached.has(r.infoHash));
        }
      } catch {
        // Availability check failed — probe the whole ranked list.
      }
    } else {
      // Real-Debrid: only add releases it (or the DMM index) reports cached.
      // Uncached RD downloads are not supported, so nothing is offered for them.
      let filter: Set<string> | null = null;
      try {
        const avail = await this.rd.instantAvailability(ranked.map((r) => r.infoHash));
        if (avail && avail.size > 0) filter = avail;
      } catch {
        // Availability endpoint failed — fall back to the index hints.
      }
      if (!filter) {
        try {
          const hinted = await this.search.checkCached(ranked.map((r) => r.infoHash));
          if (hinted.size > 0) filter = hinted;
        } catch {
          // Unknown cache state — probe everything.
        }
      }
      playable = filter ? ranked.filter((r) => filter!.has(r.infoHash)) : ranked;
    }

    const streams: Stream[] = [];
    if (playable.length > 0) {
      console.warn(`[tt] probing ${playable.length} cached candidate(s) for "${name}"`);
      try {
        const got = await findCachedStreams(this.rd, playable, {
          season, episode, negatives,
          preferredLanguages: preferredList,
          minQuality: this.qualityFilters.minQuality,
          excludeQuality: this.qualityFilters.excludeQuality,
          maxResolution: this.qualityFilters.maxResolution,
          maxSizeBytes: this.qualityFilters.maxSizeBytes,
        });
        streams.push(...got);
      } catch (err) {
        console.warn('[tt] index probe failed:', err instanceof Error ? err.message : err);
      }
    }

    // Explicit downloads: uncached releases become click-to-download rows below
    // the cached streams. Nothing is added to the account until the user clicks
    // one of these rows (TorBox download-enabled installs only). Hash already in
    // the cloud or blocked by the provider are never offered.
    if (this.rd.allowUncached && this.downloadActionUrl) {
      streams.push(...buildDownloadRows(uncached, {
        minQuality: this.qualityFilters.minQuality,
        excludeQuality: this.qualityFilters.excludeQuality,
        maxResolution: this.qualityFilters.maxResolution,
        maxSizeBytes: this.qualityFilters.maxSizeBytes,
        negatives,
        cloudHashes,
        preferredLanguages: preferredList,
        actionUrl: this.downloadActionUrl,
      }));
    }

    if (this.negativesStore) this.negativesStore.saveSoon();
    else this.caches.misc.set(negKey, negatives);
    return streams;
  }
}
