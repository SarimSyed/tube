import type { RdGateway } from '../services/realdebrid.js';
import type { CacheSet } from '../services/cache.js';
import type { SearchService } from '../services/search.js';
import type { NegativeStore } from '../services/negativeStore.js';
import type { ContentType, Stream, StreamResponse } from '../stremio.js';
import type { TorrentResult } from '../types.js';
import { normalizeTitle, parseFilename } from '../meta/parser.js';
import { torrentStreams } from './resolver.js';
import { findCachedStreams } from './cacheProbe.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';

interface CinemetaMeta {
  meta: { id: string; type: string; name?: string; year?: string | number; releaseInfo?: string };
}

function cleanTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

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

const TITLE_SIMILARITY_THRESHOLD = 0.9;

interface YearOk {
  torrentYear?: number;
  metaYear?: number;
}

function yearsMatch({ torrentYear, metaYear }: YearOk): boolean {
  if (torrentYear === undefined || metaYear === undefined) return true;
  return torrentYear === metaYear;
}

export class TtStreamProvider {
  constructor(
    private rd: RdGateway,
    private caches: CacheSet,
    private search: SearchService | null = null,
    private negativesStore: NegativeStore | null = null,
  ) {}

  private async cinemetaMeta(type: ContentType, ttId: string): Promise<{ name: string; year?: number } | null> {
    const cacheKey = `cinemeta:${ttId}`;
    const cached = this.caches.tmdb.get(cacheKey) as { name: string; year?: number } | undefined;
    if (cached) return cached;

    try {
      const res = await fetch(`${CINEMETA}/meta/${type}/${ttId}.json`);
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
   * Streams for a normal Cinemeta id (`tt…` or `tt…:season:episode`) found by
   * matching the title against torrents already in the user's RD cloud.
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

    for (const t of torrents) {
      if (streams.length >= 10) break;
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

      let info;
      try {
        info = await this.rd.getTorrentInfo(t.id);
      } catch {
        continue;
      }
      if (!info || info.status !== 'downloaded') continue;

      for (const s of await torrentStreams(this.rd, info, season, episode)) {
        if (!s.url || seenUrls.has(s.url)) continue;
        seenUrls.add(s.url);
        streams.push(s);
        if (streams.length >= 10) break;
      }
    }

    // No cloud match: fall back to searching the index for the title and adding
    // the best result (Torrentio-style) so any title can still yield streams.
    if (streams.length === 0 && this.search) {
      const found = await this.searchAndAdd(type, meta.name, meta.year, season, episode);
      streams.push(...found);
    }

    return { streams };
  }

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

  private async searchAndAdd(
    type: ContentType,
    name: string,
    metaYear: number | undefined,
    season?: number,
    episode?: number,
  ): Promise<Stream[]> {
    if (!this.search) return [];
    let results: TorrentResult[];
    try {
      results = await this.search.search(name, type);
    } catch {
      return [];
    }
    if (results.length === 0) return [];

    // Best candidates first, then probe each against RD: cached ones stream
    // instantly, uncached ones are removed again so the account stays clean.
    const ranked = [...results].sort(
      (a, b) =>
        this.scoreCandidate(b, type, metaYear, season, episode) -
        this.scoreCandidate(a, type, metaYear, season, episode),
    );
    let candidates = ranked;
    // Prefilter to the ones the index already knows are cached (DMM data), so we
    // only add torrents that are likely instant — avoids RD add-throttling.
    try {
      const cached = this.rd.provider === 'torbox' ? new Set<string>() : await this.search.checkCached(ranked.map((r) => r.infoHash));
      if (cached.size > 0) {
        candidates = ranked.filter((r) => cached.has(r.infoHash));
      }
    } catch {
      // Unknown cache state — fall through to probing everything.
    }
    if (candidates.length === 0) {
      console.warn(`[tt] no cached candidates remain for "${name}" after index filter`);
      return [];
    }
    const negKey = 'probe-neg';
    const negatives = this.negativesStore
      ? this.negativesStore.get()
      : (this.caches.misc.get(negKey) as Set<string> | undefined) ?? new Set<string>();
    console.warn(`[tt] no cloud match for "${name}" — probing ${candidates.length} cached index result(s)`);
    try {
      const streams = await findCachedStreams(this.rd, candidates, {
        season, episode, negatives,
        canDownload: r => normalizeTitle(r.title) === normalizeTitle(name)
          && r.isSeries === (type === 'series')
          && (type !== 'movie' || yearsMatch({ torrentYear: r.year, metaYear }))
          && (season === undefined || r.season === undefined || r.season === season)
          && (episode === undefined || r.episode === undefined || r.episode === episode),
      });
      if (this.negativesStore) this.negativesStore.saveSoon();
      else this.caches.misc.set(negKey, negatives);
      return streams;
    } catch (err) {
      console.warn('[tt] index probe failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }
}
