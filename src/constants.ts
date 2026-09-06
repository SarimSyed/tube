// Catalog and paging constants shared by the manifest, route handlers, and catalogs.

/** Catalog id for the user's debrid cloud torrents (served for both movie and series types). */
export const LIBRARY_CATALOG = 'rd-library';
/** Catalog id for the user's unrestricted hoster "downloads" (both movie and series types). */
export const DOWNLOADS_CATALOG = 'rd-downloads';
/** Catalog id for torrent-index search; requires an `extra.search` parameter. */
export const SEARCH_CATALOG = 'rd-search';

/** Default page size for catalog listing/pagination. */
export const PAGE_SIZE = 50;

// Outbound HTTP timeouts (ms). Shared so the reason for each number lives in
// one place instead of being repeated as a bare literal across providers.
/** Cinemeta metadata lookups (fast, proxied for posters/name). */
export const CINEMETA_TIMEOUT_MS = 8_000;
/** Generic upstream API calls (Pirate Bay, YTS, Zilean, Torznab, TMDB, TorBox). */
export const UPSTREAM_TIMEOUT_MS = 10_000;
/** Real-Debrid REST calls — slower when polling a freshly added magnet. */
export const RD_TIMEOUT_MS = 15_000;
