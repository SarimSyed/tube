// Minimal ambient declarations for the (untyped) stremio-addon-sdk.
declare module 'stremio-addon-sdk' {
  export class addonBuilder {
    constructor(manifest: unknown);
    defineCatalogHandler(handler: unknown): void;
    defineMetaHandler(handler: unknown): void;
    defineStreamHandler(handler: unknown): void;
    getInterface(): unknown;
  }
  export function serveHTTP(addonInterface: unknown, opts?: unknown): unknown;
  export function getRouter(addonInterface: unknown): unknown;
  export function publishToCentral(url: string): unknown;
}
