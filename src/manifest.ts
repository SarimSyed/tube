// Stremio manifest construction. The manifest declares which resources the
// addon serves, and is built per-provider (Real-Debrid vs TorBox) so each gets
// its own addon id, name, and catalog set.

import type { Config } from './types.js';
import { DOWNLOADS_CATALOG, LIBRARY_CATALOG, SEARCH_CATALOG } from './constants.js';

/** Shape of the manifest object Stremio fetches from `/manifest.json`. */
export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: Array<string | Record<string, unknown>>;
  types: string[];
  idPrefixes: string[];
  catalogs: unknown[];
  behaviorHints: { configurable: boolean; configurationRequired: boolean };
  logo: string;
  background: string;
}

/**
 * Builds the Stremio manifest. The `provider` defaults to `realdebrid` and is
 * derived from the request token at runtime; TorBox gets a distinct addon id,
 * name, and catalog list (no downloads catalog, `TB`-prefixed names).
 */
export function buildManifest(config: Config, baseUrl: string, provider = 'realdebrid'): Manifest {
  const torbox = provider === 'torbox';
  const catalogs = [
    { type: 'movie', id: LIBRARY_CATALOG, name: 'RD Library' },
    { type: 'series', id: LIBRARY_CATALOG, name: 'RD Library' },
    { type: 'movie', id: DOWNLOADS_CATALOG, name: 'RD Downloads' },
    { type: 'series', id: DOWNLOADS_CATALOG, name: 'RD Downloads' },
    {
      type: 'movie',
      id: SEARCH_CATALOG,
      name: 'RD Search',
      extra: [{ name: 'search', isRequired: true }],
    },
    {
      type: 'series',
      id: SEARCH_CATALOG,
      name: 'RD Search',
      extra: [{ name: 'search', isRequired: true }],
    },
  // Optional catalogs are off by default; the search and library toggles are
  // independent so each can be enabled on its own.
  ].filter(c => c.id === SEARCH_CATALOG ? config.showSearchCatalogs : config.showLibraryCatalogs);

  return {
    id: torbox ? `${config.addonId}.torbox` : config.addonId,
    version: config.version,
    name: torbox ? 'Tube (TorBox)' : config.addonName,
    description: torbox ? 'TorBox streams on standard Stremio movie and episode pages, with optional cloud catalogs.' : config.addonDescription,
    resources: [
      { name: 'catalog', types: ['movie', 'series'] },
      // Meta is only served for OUR ids; normal tt titles get their meta from
      // Cinemeta (declaring tt here makes Stremio ask us and breaks posters).
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['rd:', 'sr:'] },
      // Standard title/episode requests search the cloud and torrent index.
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'rd:', 'sr:'] },
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'rd:', 'sr:'],
    catalogs: torbox ? catalogs.filter(c => c.id !== DOWNLOADS_CATALOG).map(c => ({ ...c, name: c.name.replace(/^RD /, 'TB ') })) : catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
    logo: `${baseUrl}/static/logo.png`,
    background: `${baseUrl}/static/background.png`,
  };
}
