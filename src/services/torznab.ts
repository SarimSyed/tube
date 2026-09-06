/**
 * Torznab provider: a client for the Jackett/Prowlarr `api` endpoint. The RSS
 * XML response is parsed with regex (no XML parser dependency) and each
 * `<item>` is normalized into a {@link TorrentResult}.
 */
import type { TorrentProvider, TorrentResult } from '../types.js';
import { guessType, parseFilename } from '../meta/parser.js';
import { UPSTREAM_TIMEOUT_MS } from '../constants.js';

/**
 * Extract a `torznab:attr` value from an item's raw XML. Attribute order varies
 * across indexers, so both name-then-value and value-then-name are matched.
 */
function extractAttr(item: string, attrName: string): string | undefined {
  const re = new RegExp(`torznab:attr[^>]*name=["']${attrName}["'][^>]*value=["']([^"']*)["']`, 'i');
  const m = item.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`name=["']${attrName}["'][^>]*value=["']([^"']*)["']`, 'i');
  const m2 = item.match(re2);
  return m2 ? m2[1] : undefined;
}

/**
 * Queries `{baseUrl}/api` with `apikey`, `t=search`, and `q`. The infohash is
 * read from a `torznab:attr` or a magnet `btih:` link; size/seeders/imdb come
 * from the matching attributes. Titles are CDATA/entity-stripped and parsed
 * with parseFilename, with `guessType` as a series fallback.
 */
export class TorznabProvider implements TorrentProvider {
  name = 'torznab';

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  /**
   * Fetch `GET /api?apikey=...&t=search&q=...` and parse each `<item>`. Returns
   * [] on network/HTTP errors; items without a recoverable infohash are skipped.
   */
  async search(query: string): Promise<TorrentResult[]> {
    const params = new URLSearchParams({ apikey: this.apiKey, t: 'search', q: query });
    const url = `${this.baseUrl.replace(/\/$/, '')}/api?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      console.warn(`[torznab] request failed for "${query}":`, err instanceof Error ? err.message : err);
      return [];
    }
    if (!res.ok) {
      console.warn(`[torznab] HTTP ${res.status} for "${query}"`);
      return [];
    }
    const xml = await res.text();

    const results: TorrentResult[] = [];
    // Torznab returns RSS 2.0; match `<item>` blocks lazily across newlines.
    const itemRe = /<item[\s\S]*?<\/item>/gi;
    let item: RegExpExecArray | null;
    while ((item = itemRe.exec(xml)) !== null) {
      const block = item[0];
      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
      if (!titleMatch) continue;
      // Strip CDATA wrappers and any nested markup before parsing the title.
      const rawTitle = titleMatch[1]
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();

      const enclosure = block.match(/<enclosure[^>]*>/i)?.[0] ?? '';
      const magnet = enclosure.match(/url=["']([^"']+)["']/i)?.[1] ?? '';
      // Prefer an explicit infohash attr; else recover it from the magnet `btih:`.
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
        // guessType catches packs like "Show Season 1" that parseFilename missed.
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
