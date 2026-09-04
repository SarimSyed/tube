import type { TorrentProvider, TorrentResult } from '../types.js';

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

export class ZileanProvider implements TorrentProvider {
  name = 'zilean';

  constructor(
    private baseUrl: string,
    private apiKey?: string,
  ) {}

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

  /** Hashes the index marks as cached on a debrid (DMM shared-hashlist data). */
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
