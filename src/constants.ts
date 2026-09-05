// Catalog and paging constants shared by the manifest, route handlers, and catalogs.

/** Catalog id for the user's debrid cloud torrents (served for both movie and series types). */
export const LIBRARY_CATALOG = 'rd-library';
/** Catalog id for the user's unrestricted hoster "downloads" (both movie and series types). */
export const DOWNLOADS_CATALOG = 'rd-downloads';
/** Catalog id for torrent-index search; requires an `extra.search` parameter. */
export const SEARCH_CATALOG = 'rd-search';

/** Default page size for catalog listing/pagination. */
export const PAGE_SIZE = 50;
