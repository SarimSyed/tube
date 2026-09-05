// Minimal ambient declarations for the (untyped) stremio-addon-sdk. Only the
// pieces Tube uses are declared; the `unknown` types reflect that the package
// ships no type information. `addonBuilder` is used solely to lint the manifest
// at startup — Tube serves its routes via plain Express instead of the SDK's
// handler/router helpers.
declare module 'stremio-addon-sdk' {
  /** Builds a Stremio addon interface; used here only to validate the manifest. */
  export class addonBuilder {
    constructor(manifest: unknown);
    defineCatalogHandler(handler: unknown): void;
    defineMetaHandler(handler: unknown): void;
    defineStreamHandler(handler: unknown): void;
    getInterface(): unknown;
  }
  /** Serves an addon interface over HTTP (unused; Tube uses Express). */
  export function serveHTTP(addonInterface: unknown, opts?: unknown): unknown;
  /** Returns an Express router for an addon interface (unused; Tube uses Express). */
  export function getRouter(addonInterface: unknown): unknown;
  /** Publishes the addon manifest to Stremio's central catalog (unused). */
  export function publishToCentral(url: string): unknown;
}
