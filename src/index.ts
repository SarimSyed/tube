// Tube addon entry point. Wires config, caches, negative stores, debrid clients,
// catalogs, the meta service, and the stream resolver into an Express server that
// implements the Stremio protocol (manifest / catalog / meta / stream) plus a
// `/configure` setup page.
//
// The debrid token is not persisted server-side for Stremio traffic: the client
// installs the addon with the token embedded in the URL path (e.g.
// `/<token>/manifest.json`). `resolveToken` reads that segment (falling back to
// `?apiKey=` or `RD_API_KEY`), and a fresh debrid client is built per request so
// each provider/token gets its own identity and data.
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addonBuilder } from 'stremio-addon-sdk';

import { loadConfig } from './config.js';
import type { Config } from './types.js';
import { createCaches } from './services/cache.js';
import { RealDebridError } from './services/realdebrid.js';
import { createDebridClient, preferredLanguages } from './services/debrid.js';
import { CachedRealDebrid } from './services/cachedRd.js';
import { TmdbClient } from './services/tmdb.js';
import { ZileanProvider } from './services/zilean.js';
import { TorznabProvider } from './services/torznab.js';
import { PirateBayProvider } from './services/piratebay.js';
import { YtsProvider } from './services/yts.js';
import { SearchService } from './services/search.js';
import { MetaService } from './meta/meta.js';
import { LibraryCatalog } from './catalogs/library.js';
import { SearchCatalog } from './catalogs/search.js';
import { StreamResolver } from './stream/resolver.js';
import { TtStreamProvider } from './stream/tt.js';
import { NegativeStore } from './services/negativeStore.js';
import { buildManifest } from './manifest.js';
import { renderConfigurePage } from './configure.js';
import { DOWNLOADS_CATALOG, LIBRARY_CATALOG, SEARCH_CATALOG } from './constants.js';
import type { ContentType, Meta } from './stremio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: Config = loadConfig();
const caches = createCaches(config.cacheTtlSeconds);
// The old probe-neg cache also contained transient failures and uncached files.
const negativeStore = new NegativeStore(join(config.dataDir, 'blocked-hashes.json'));
const torboxNegatives = new NegativeStore(join(config.dataDir, 'torbox-blocked-hashes.json'));

// Lint the manifest once at startup for early feedback (warnings only; never fatal).
try {
  new addonBuilder(buildManifest(config, 'http://localhost') as never);
} catch (err) {
  console.error('Manifest lint error:', err);
}

// Global safety net: surface otherwise-silent async failures so a bug is not
// invisible. Tokens live in the URL path / request, never in these messages.
function logUnexpected(kind: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`[process] ${kind}: ${err.name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`[process] ${kind}:`, err);
  }
}
process.on('unhandledRejection', (reason) => logUnexpected('unhandledRejection', reason));
process.on('uncaughtException', (err) => logUnexpected('uncaughtException', err));

const tmdb = config.tmdbApiKey ? new TmdbClient(config.tmdbApiKey) : null;
const metaService = new MetaService(tmdb, caches);

// Torrent indexes, queried in order. Zilean and Torznab are opt-in; The Pirate
// Bay is always registered so search has at least one backend.
const providers = [];
if (config.zileanUrl) providers.push(new ZileanProvider(config.zileanUrl, config.zileanApiKey ?? undefined));
providers.push(new PirateBayProvider());
providers.push(new YtsProvider());
if (config.torznabUrl && config.torznabApiKey) {
  providers.push(new TorznabProvider(config.torznabUrl, config.torznabApiKey));
}
const searchService = new SearchService(providers, caches);

/**
 * Absolute base URL for building self-referential manifest/static links.
 * Prefers the configured `BASE_URL` (trailing slash stripped); otherwise
 * reconstructs it from the request, honoring the left-most `X-Forwarded-Proto`
 * value so links stay correct behind a reverse proxy.
 */
function requestBaseUrl(req: Request): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

/**
 * Resolves the debrid credential for a request from, in order: the `:token`
 * path segment (already URL-decoded by Express — do NOT decode again, or a
 * token containing a literal `%` would be corrupted), the `?apiKey=` query
 * param, or `RD_API_KEY`. Returns `null` when none is present, so callers can
 * redirect to `/configure`.
 */
function resolveToken(req: Request): string | null {
  const pathToken = req.params.token;
  if (pathToken) return pathToken;
  const queryToken = req.query.apiKey;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return config.rdApiKey;
}

/**
 * Parses Stremio's `extra` path segment (a URL query string, sometimes with a
 * trailing `.json`) into `search` and `skip` for catalog filtering/paging.
 */
function parseExtra(raw: string): { search?: string; skip?: number } {
  const out: { search?: string; skip?: number } = {};
  if (!raw) return out;
  const params = new URLSearchParams(raw.replace(/\.json$/, ''));
  const search = params.get('search');
  if (search) out.search = search;
  const skip = params.get('skip');
  if (skip) {
    const n = Number.parseInt(skip, 10);
    if (Number.isFinite(n)) out.skip = n;
  }
  return out;
}

/** Decodes a path segment and drops Stremio's trailing `.json` suffix. */
function stripJson(id: string): string {
  return decodeURIComponent(id.replace(/\.json$/, ''));
}

/**
 * Uniform error response. A 401 from Real-Debrid maps to Stremio's
 * `invalid_token` code (prompting the client to re-open `/configure`); anything
 * else is logged server-side and returned as a generic 500.
 */
function sendError(res: Response, err: unknown): void {
  if (err instanceof RealDebridError && err.status === 401) {
    res.status(401).json({ err: 'invalid_token', hint: 'Re-open /configure to update your token' });
    return;
  }
  console.error(err);
  res.status(500).json({ err: 'internal_error' });
}

const app = express();
// Export so tests (and the singleton-mode app) can import and mount it.
export { app };
app.disable('x-powered-by');

// Stremio addon protocol requires CORS on every route (clients fetch addons
// cross-origin from the app/web origins).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Light request logger. Logs the matched route *pattern* (e.g. '/:token/stream/:type/:id'),
// never the raw URL, so the token embedded in the path is not leaked to logs.
app.use((req, res, next) => {
  const t0 = performance.now();
  res.on('finish', () => {
    const ms = Math.round(performance.now() - t0);
    const pattern = req.route?.path ?? '';
    console.log(`[http] ${req.method} ${pattern} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get('/', (_req, res) => {
  res.redirect(307, '/configure');
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/configure', (req, res) => {
  res.type('html').send(renderConfigurePage(requestBaseUrl(req)));
});

// Stremio opens "Configure" relative to the addon URL path (e.g.
// /<token>/configure), so serve the same page there.
app.get('/:token/configure', (req, res) => {
  res.type('html').send(renderConfigurePage(requestBaseUrl(req)));
});

app.use('/static', express.static(join(__dirname, '..', 'public')));

// ---- manifest ----
/**
 * Serves the Stremio manifest. It is built per request because the provider
 * identity (RD vs TorBox) — and therefore the addon id/name and catalog set —
 * depends on the token. Without a token, redirect to `/configure` so Stremio's
 * "Configure" flow can collect one.
 */
function manifestHandler(req: Request, res: Response): void {
  const token = resolveToken(req);
  if (!token) {
    res.redirect(307, '/configure');
    return;
  }
  res.type('application/json').send(buildManifest(config, requestBaseUrl(req), createDebridClient(token, config).provider));
}
// Both mount points: the bare path (token via query/env) and the token-in-path
// form Stremio installs.
app.get('/manifest.json', manifestHandler);
app.get('/:token/manifest.json', manifestHandler);

// ---- catalog ----
/**
 * Serves library/downloads/search catalogs. A fresh debrid client is built per
 * request from the token; `SEARCH_CATALOG` queries the torrent index while
 * `LIBRARY_CATALOG` / `DOWNLOADS_CATALOG` list the user's debrid cloud. Unknown
 * ids resolve to an empty list so Stremio's discovery browsing stays quiet.
 */
function catalogHandler(req: Request, res: Response): void {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ err: 'missing_token', hint: 'Open /configure to set your Real-Debrid token' });
    return;
  }
  const rd = new CachedRealDebrid(createDebridClient(token, config), caches);
  const library = new LibraryCatalog(rd, metaService);
  const searchCatalog = new SearchCatalog(rd, searchService, metaService, caches, config.includeUncached);

  const type = stripJson(req.params.type) as ContentType;
  const id = stripJson(req.params.id);
  const extra = parseExtra(req.params.extra ?? '');
  const baseUrl = requestBaseUrl(req);

  const promise = (() => {
    if (id === SEARCH_CATALOG) {
      return searchCatalog.catalog(type, extra.search, baseUrl);
    }
    if (id === LIBRARY_CATALOG || id === DOWNLOADS_CATALOG) {
      return library.list(id, type, extra.skip ?? 0, extra.search, baseUrl);
    }
    return Promise.resolve({ metas: [] });
  })();

  console.log(`[catalog] ${type}/${id} search=${extra.search ?? ''} skip=${extra.skip ?? 0}`);
  promise
    .then((resp) => {
      console.log(`[catalog] ${type}/${id} -> ${resp.metas.length} metas`);
      res.json(resp);
    })
    .catch((err) => sendError(res, err));
}
app.get('/:token/catalog/:type/:id', catalogHandler);
app.get('/:token/catalog/:type/:id/:extra', catalogHandler);

// ---- meta ----
/**
 * Serves meta for OUR ids (`rd:` library, `sr:` search). Normal `tt` ids are
 * proxied to Cinemeta as a safety net (see below) so posters keep working even
 * if a client ignores the manifest's `idPrefixes`.
 */
function metaHandler(req: Request, res: Response): void {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ err: 'missing_token' });
    return;
  }
  const rd = new CachedRealDebrid(createDebridClient(token, config), caches);
  const library = new LibraryCatalog(rd, metaService);
  const searchCatalog = new SearchCatalog(rd, searchService, metaService, caches, config.includeUncached);

  const type = stripJson(req.params.type) as ContentType;
  const id = stripJson(req.params.id);
  const baseUrl = requestBaseUrl(req);

  // Safety net: if a client still asks us for a normal tt item's meta (e.g. it
  // ignores per-resource idPrefixes), proxy Cinemeta instead of returning 404,
  // so posters/detail pages keep working.
  let promise: Promise<Meta | null>;
  if (/^tt\d+/.test(id)) {
    promise = proxyCinemetaMeta(type, id);
  } else if (id.startsWith('sr:')) {
    promise = searchCatalog.meta(id, baseUrl);
  } else {
    promise = library.meta(id, baseUrl);
  }

  console.log(`[meta] ${type}/${id}`);
  promise
    .then((meta) => {
      if (!meta) {
        console.log(`[meta] ${type}/${id} -> not found`);
        res.status(404).json({ err: 'not_found' });
        return;
      }
      res.json({ meta });
    })
    .catch((err) => sendError(res, err));
}
app.get('/:token/meta/:type/:id', metaHandler);

/** Fetch Cinemeta's meta for a normal tt id and pass it through unchanged. */
async function proxyCinemetaMeta(type: ContentType, id: string): Promise<Meta | null> {
  const ttId = id.split(':')[0];
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { meta?: Meta };
    return data.meta ?? null;
  } catch {
    return null;
  }
}

// ---- stream ----
/**
 * Resolves streams for a title. `tt` ids go through the full search path
 * (cloud + torrent index), while `rd:`/`sr:` ids resolve a specific stored item.
 * TorBox and Real-Debrid keep separate negative stores so a hash blocked on one
 * provider does not poison the other.
 */
function streamHandler(req: Request, res: Response): void {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ err: 'missing_token' });
    return;
  }
  const rd = new CachedRealDebrid(createDebridClient(token, config), caches);
  const negatives = rd.provider === 'torbox' ? torboxNegatives : negativeStore;
  const langs = preferredLanguages(token);
  const resolver = new StreamResolver(rd, { search: searchService, caches, negatives, preferredLanguages: langs });
  const ttProvider = new TtStreamProvider(rd, caches, searchService, negatives, langs, {
    minQuality: config.minQuality ?? undefined,
    excludeQuality: config.excludeQuality,
  });

  const type = stripJson(req.params.type) as ContentType;
  const id = stripJson(req.params.id);
  const promise = id.startsWith('tt')
    ? ttProvider.resolve(type, id)
    : resolver.resolve(id);

  console.log(`[stream] ${type}/${id} provider=${rd.provider} download=${rd.allowUncached ? 'on' : 'off'}`);
  promise
    .then((resp) => {
      console.log(`[stream] ${type}/${id} -> ${resp.streams.length} stream(s)`);
      res.json(resp);
    })
    .catch((err) => sendError(res, err));
}
app.get('/:token/stream/:type/:id', streamHandler);

// RD_API_KEY singleton mode: when a server-side token is configured, the addon
// is also mounted without a `:token` path segment so `/manifest.json` installs
// work end-to-end (Stremio resolves catalog/meta/stream under the manifest's
// base). Each handler resolves the token to `config.rdApiKey`. These routes are
// only registered when a singleton key is present.
if (config.rdApiKey) {
  app.get('/catalog/:type/:id', catalogHandler);
  app.get('/catalog/:type/:id/:extra', catalogHandler);
  app.get('/meta/:type/:id', metaHandler);
  app.get('/stream/:type/:id', streamHandler);
}

// JSON 404 for any unmatched route — Stremio clients expect JSON, not HTML.
// (No path is echoed: the request path may carry the user's token.)
app.use((_req: Request, res: Response) => {
  res.status(404).json({ err: 'not_found' });
});

// Error middleware: normalize synchronous throws from handlers to JSON errors.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  sendError(res, err);
});

const port = config.port;
// Only bind the port when this file is the entry module. Importing `index.js`
// in tests builds the Express app (exported as `app`) without starting a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, () => {
    console.log(`Tube addon listening on http://0.0.0.0:${port}`);
    console.log(`Open http://<host>:${port}/configure to set up Real-Debrid`);
    if (providers.length === 0) {
      console.warn('No search provider configured (ZILEAN_URL / TORZNAB_URL empty) — streams are limited to your cloud library.');
    }
  });
}
