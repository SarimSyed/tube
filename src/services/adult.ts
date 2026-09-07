// Adult-content filtering for torrent-index search results. Indexes (The Pirate
// Bay, Zilean, Torznab) mix adult releases into normal queries — adult studios
// reuse mainstream titles (e.g. "Obsession"), so a plain title search can
// surface porn. Tube filters those out by default so searching for a specific
// movie never returns adult releases.
import type { TorrentResult } from '../types.js';

/**
 * Release-name markers strongly associated with adult content (studio names and
 * explicit words). Kept deliberately narrow so mainstream titles (e.g. the
 * action film "xXx") are not caught — `xxx` alone is NOT a marker.
 */
const ADULT_MARKERS = [
  'porn', 'pornhub', 'xvideos', 'redtube', 'brazzers', 'bangbros', 'realitykings',
  'reality kings', 'naughtyamerica', 'naughty america', 'evilangel', 'evil angel',
  'teamskeet', 'twistys', 'playboy', 'hustler', 'milf', 'blacked', 'creampie',
  'gangbang', 'hentai', 'onlyfans',
];

/**
 * Numeric index categories that denote adult content. The Pirate Bay uses the
 * 5xx range; Torznab/Jackett use the 5xxx range (5000+).
 */
function isAdultCategory(category: string | undefined): boolean {
  if (!category) return false;
  const c = category.trim();
  if (/^5\d{2}$/.test(c)) return true; // TPB 501–599
  if (/^5\d{3}$/.test(c)) return true; // Torznab 5xxx
  const lower = c.toLowerCase();
  return ['xxx', 'porn', 'adult', 'hentai'].some((w) => lower.includes(w));
}

/** Match a marker as a whole word against release text (metacharacters escaped). */
function hasMarker(text: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * True when a search result is (or looks like) adult content: an adult index
 * category, or a release name/studio marker. Applied to every result before it
 * is returned or cached by {@link SearchService}.
 */
export function isAdultRelease(result: TorrentResult): boolean {
  if (isAdultCategory(result.category)) return true;
  const text = `${result.raw ?? ''} ${result.title ?? ''} ${result.category ?? ''}`;
  return ADULT_MARKERS.some((m) => hasMarker(text, m));
}
