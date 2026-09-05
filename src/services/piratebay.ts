import type { TorrentProvider, TorrentResult } from '../types.js';
import { parseFilename } from '../meta/parser.js';

interface ApibayItem {
  name?: string;
  info_hash?: string;
  leechers?: string;
  seeders?: string;
  size?: string;
  imdb?: string;
  category?: string;
}

const TV_CATEGORIES = new Set(['205', '208']);

/**
 * The Pirate Bay via the free apibay.org JSON API. Provides live releases with
 * seeder counts and IMDb ids — the missing piece for "download then stream" on
 * TorBox when the DMM/Zilean hashlist has not ingested a title yet.
 */
export class PirateBayProvider implements TorrentProvider {
  name = 'piratebay';

  async search(query: string): Promise<TorrentResult[]> {
    let res: Response;
    try {
      res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TubeStremioAddon/1.0)' },
      });
    } catch {
      return [];
    }
    if (!res.ok) return [];

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];

    const out: TorrentResult[] = [];
    for (const raw of data as ApibayItem[]) {
      if (!raw.info_hash) continue;
      const parsed = parseFilename(raw.name ?? raw.info_hash);
      const category = raw.category ?? '';
      const seeders = Number(raw.seeders);
      const sizeBytes = Number(raw.size);
      out.push({
        infoHash: raw.info_hash.toLowerCase(),
        title: parsed.title || raw.name || raw.info_hash,
        quality: parsed.quality,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        isSeries: TV_CATEGORIES.has(category) || parsed.isSeries,
        imdbId: raw.imdb && /^tt\d+$/.test(raw.imdb) ? raw.imdb : undefined,
        seeders: Number.isFinite(seeders) ? seeders : undefined,
        sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : undefined,
        raw: raw.name ?? raw.info_hash,
        source: 'piratebay',
      });
    }
    return out;
  }
}
