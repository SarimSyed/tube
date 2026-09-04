// ID encoding/decoding for this addon's meta/video identifiers.
// All ids are self-defined (prefixed `rd:` / `sr:`) so the addon owns them.
import type { TorrentResult } from './types.js';

export type LibraryId =
  | { kind: 'torrent'; torrentId: string }
  | { kind: 'download'; downloadId: string }
  | { kind: 'episode'; torrentId: string; season: number; episode: number };

export function torrentId(id: string): string {
  return `rd:${id}`;
}

export function downloadId(id: string): string {
  return `rd:dl:${id}`;
}

export function episodeId(torrentId: string, season: number, episode: number): string {
  return `rd:${torrentId}:${season}:${episode}`;
}

export function searchId(infoHash: string, context?: TorrentResult): string {
  const id = `sr:${infoHash.toLowerCase()}`;
  if (!context) return id;
  const { title, year, isSeries, season, episode, imdbId } = context;
  return `${id}:${Buffer.from(JSON.stringify({ title, year, isSeries, season, episode, imdbId })).toString('base64url')}`;
}

/** Keep bookmarked search items usable after the server cache expires/restarts. */
export function parseSearchContext(id: string): TorrentResult | null {
  const hash = parseSearchId(id);
  const encoded = id.split(':')[2];
  if (!hash || !encoded || encoded.length > 4096) return null;
  try {
    const c = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!c || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 500 || typeof c.isSeries !== 'boolean') return null;
    for (const key of ['year', 'season', 'episode']) {
      if (c[key] !== undefined && (!Number.isInteger(c[key]) || c[key] < 0)) return null;
    }
    if (c.imdbId !== undefined && (typeof c.imdbId !== 'string' || !/^tt\d+$/.test(c.imdbId))) return null;
    return { infoHash: hash, title: c.title, year: c.year, isSeries: c.isSeries, season: c.season, episode: c.episode, imdbId: c.imdbId, raw: c.title, source: 'zilean' };
  } catch {
    return null;
  }
}

export function parseLibraryId(id: string): LibraryId | null {
  if (id.startsWith('rd:dl:')) {
    const download = id.slice('rd:dl:'.length);
    return download ? { kind: 'download', downloadId: download } : null;
  }
  if (id.startsWith('rd:')) {
    const rest = id.slice('rd:'.length);
    const parts = rest.split(':');
    if (parts.length === 3) {
      const season = Number.parseInt(parts[1], 10);
      const episode = Number.parseInt(parts[2], 10);
      if (parts[0] && Number.isFinite(season) && Number.isFinite(episode)) {
        return { kind: 'episode', torrentId: parts[0], season, episode };
      }
    }
    if (parts.length === 1 && parts[0]) return { kind: 'torrent', torrentId: parts[0] };
  }
  return null;
}

export function parseSearchId(id: string): string | null {
  if (id.startsWith('sr:')) {
    const hash = id.slice('sr:'.length).split(':')[0];
    return hash ? hash : null;
  }
  return null;
}
