import type { TorrentProvider, TorrentResult } from '../types.js';
import { guessType, parseFilename } from '../meta/parser.js';

function extractAttr(item: string, attrName: string): string | undefined {
  const re = new RegExp(`torznab:attr[^>]*name=["']${attrName}["'][^>]*value=["']([^"']*)["']`, 'i');
  const m = item.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`name=["']${attrName}["'][^>]*value=["']([^"']*)["']`, 'i');
  const m2 = item.match(re2);
  return m2 ? m2[1] : undefined;
}

export class TorznabProvider implements TorrentProvider {
  name = 'torznab';

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async search(query: string): Promise<TorrentResult[]> {
    const params = new URLSearchParams({ apikey: this.apiKey, t: 'search', q: query });
    const url = `${this.baseUrl.replace(/\/$/, '')}/api?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return [];
    }
    if (!res.ok) return [];
    const xml = await res.text();

    const results: TorrentResult[] = [];
    const itemRe = /<item[\s\S]*?<\/item>/gi;
    let item: RegExpExecArray | null;
    while ((item = itemRe.exec(xml)) !== null) {
      const block = item[0];
      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
      if (!titleMatch) continue;
      const rawTitle = titleMatch[1]
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();

      const enclosure = block.match(/<enclosure[^>]*>/i)?.[0] ?? '';
      const magnet = enclosure.match(/url=["']([^"']+)["']/i)?.[1] ?? '';
      const hashFromMagnet = magnet.match(/btih:([0-9a-fA-F]{32,40})/i)?.[1];
      const infohash = (extractAttr(block, 'infohash') ?? hashFromMagnet ?? '').toLowerCase();
      if (!infohash) continue;

      const sizeAttr = extractAttr(block, 'size');
      const sizeBytes = sizeAttr ? Number(sizeAttr) : NaN;
      const seedersAttr = extractAttr(block, 'seeders');
      const seeders = seedersAttr ? Number.parseInt(seedersAttr, 10) : undefined;
      const imdb = extractAttr(block, 'imdb');

      const parsed = parseFilename(rawTitle);
      results.push({
        infoHash: infohash,
        title: parsed.title,
        sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : undefined,
        sizeLabel: undefined,
        quality: parsed.quality,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        isSeries: parsed.isSeries || guessType(rawTitle) === 'series',
        imdbId: imdb,
        seeders,
        raw: rawTitle,
        source: 'torznab',
      });
    }
    return results;
  }
}
