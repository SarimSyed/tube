/**
 * Zilean provider: the DMM (DebridMediaManager) hash-list backend. `search`
 * queries its public index, while `checkCached` asks the shared hashlist which
 * of our hashes are already cached on a debrid. Unlike the other providers,
 * Zilean reports no seeder counts — only on-demand cached/uncached hints.
 */
import type { TorrentProvider, TorrentResult } from '../types.js';

/** One entry from Zilean's DMM search API (`POST /dmm/search` response shape). */
interface ZileanTorrent {
  raw_title?: string;
  parsed_title?: string;
  normalized_title?: string;
  cleaned_parsed_title?: string;
  year?: number;
  resolution?: string;
  seasons?: number[];
  episodes?: number[];
  quality?: string;
  codec?: string;
  languages?: string[];
  group?: string;
  size?: string;
  category?: string;
  imdb_id?: string;
  info_hash: string;
  adult?: boolean;
}

/**
 * Normalize a Zilean hit into a {@link TorrentResult}. Returns null when the
 * entry lacks an `info_hash`. Series detection relies on the category or the
 * seasons/episodes arrays, since the index supplies no seeder count.
 */
function toResult(t: ZileanTorrent): TorrentResult | null {
  if (!t.info_hash) return null;
  const raw = t.raw_title ?? t.parsed_title ?? t.info_hash;
  const title = t.cleaned_parsed_title ?? t.parsed_title ?? t.normalized_title ?? raw;
  const category = (t.category ?? '').toLowerCase();
  const isSeries = !!(
    category === 'tv' ||
    (t.seasons && t.seasons.length > 0) ||
    (t.episodes && t.episodes.length > 0)
  );

  return {
    infoHash: t.info_hash.toLowerCase(),
    title: title || raw,
    sizeLabel: t.size,
    quality: t.resolution ?? t.quality,
    year: t.year && t.year > 0 ? t.year : undefined,
    season: t.seasons?.[0],
    episode: t.episodes?.[0],
    isSeries,
    category,
    imdbId: t.imdb_id || undefined,
    raw,
    source: 'zilean',
  };
}

/**
 * Zilean client. Endpoints: public `POST /dmm/search` (JSON `{ QueryText }`)
 * and authenticated `GET /torrents/checkcached` (header `X-API-Key`). Results
 * differ from Torznab/Pirate Bay: no seeder counts, and `checkCached` is the
 * only source of instant-availability hints.
 */
export class ZileanProvider implements TorrentProvider {
  name = 'zilean';

  constructor(
    private baseUrl: string,
    private apiKey?: string,
  ) {}

  /** Query `POST /dmm/search`; returns [] on HTTP error or a non-array body. */
  async search(query: string): Promise<TorrentResult[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/dmm/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ QueryText: query }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as ZileanTorrent[];
    if (!Array.isArray(data)) return [];
    return data.map(toResult).filter((r): r is TorrentResult => r !== null);
  }

  /**
   * Ask `GET /torrents/checkcached` (auth `X-API-Key`) which of the given hashes
   * the DMM shared hashlist marks as cached on a debrid. Returns an empty set
   * when no API key is configured or on any error (non-fatal fallback).
   */
  async checkCached(hashes: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.apiKey || hashes.length === 0) return out;
    try {
      const qs = new URLSearchParams({ hashes: hashes.join(',') });
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/torrents/checkcached?${qs}`, {
        headers: { 'X-API-Key': this.apiKey },
      });
      if (!res.ok) return out;
      const items = (await res.json()) as Array<{ info_hash?: string; is_cached?: boolean | null }>;
      for (const it of items) {
        if (it.is_cached && it.info_hash) out.add(it.info_hash.toLowerCase());
      }
    } catch {
      // Non-fatal: fall back to probing all candidates.
    }
    return out;
  }
}
