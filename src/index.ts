import express from 'express';
import type { Request, Response } from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addonBuilder } from 'stremio-addon-sdk';

import { loadConfig } from './config.js';
import type { Config } from './types.js';
import { createCaches } from './services/cache.js';
import { RealDebridError } from './services/realdebrid.js';
import { createDebridClient } from './services/debrid.js';
import { CachedRealDebrid } from './services/cachedRd.js';
import { TmdbClient } from './services/tmdb.js';
import { ZileanProvider } from './services/zilean.js';
import { TorznabProvider } from './services/torznab.js';
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

const tmdb = config.tmdbApiKey ? new TmdbClient(config.tmdbApiKey) : null;
const metaService = new MetaService(tmdb, caches);

const providers = [];
if (config.zileanUrl) providers.push(new ZileanProvider(config.zileanUrl, config.zileanApiKey ?? undefined));
if (config.torznabUrl && config.torznabApiKey) {
  providers.push(new TorznabProvider(config.torznabUrl, config.torznabApiKey));
}
const searchService = new SearchService(providers, caches);

function requestBaseUrl(req: Request): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function resolveToken(req: Request): string | null {
  const pathToken = req.params.token;
  if (pathToken) return decodeURIComponent(pathToken);
  const queryToken = req.query.apiKey;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return config.rdApiKey;
}

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

function stripJson(id: string): string {
  return decodeURIComponent(id.replace(/\.json$/, ''));
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof RealDebridError && err.status === 401) {
    res.status(401).json({ err: 'invalid_token', hint: 'Re-open /configure to update your token' });
    return;
  }
  console.error(err);
  res.status(500).json({ err: 'internal_error' });
}

const app = express();
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
function manifestHandler(req: Request, res: Response): void {
  const token = resolveToken(req);
  if (!token) {
    res.redirect(307, '/configure');
    return;
  }
  res.type('application/json').send(buildManifest(config, requestBaseUrl(req), createDebridClient(token, config).provider));
}
app.get('/manifest.json', manifestHandler);
app.get('/:token/manifest.json', manifestHandler);

// ---- catalog ----
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
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as { meta?: Meta };
    return data.meta ?? null;
  } catch {
    return null;
  }
}

// ---- stream ----
function streamHandler(req: Request, res: Response): void {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ err: 'missing_token' });
    return;
  }
  const rd = new CachedRealDebrid(createDebridClient(token, config), caches);
  const negatives = rd.provider === 'torbox' ? torboxNegatives : negativeStore;
  const resolver = new StreamResolver(rd, { search: searchService, caches, negatives });
  const ttProvider = new TtStreamProvider(rd, caches, searchService, negatives);

  const type = stripJson(req.params.type) as ContentType;
  const id = stripJson(req.params.id);
  const promise = id.startsWith('tt')
    ? ttProvider.resolve(type, id)
    : resolver.resolve(id);

  console.log(`[stream] ${type}/${id}`);
  promise
    .then((resp) => {
      console.log(`[stream] ${type}/${id} -> ${resp.streams.length} stream(s)`);
      res.json(resp);
    })
    .catch((err) => sendError(res, err));
}
app.get('/:token/stream/:type/:id', streamHandler);

const port = config.port;
app.listen(port, () => {
  console.log(`Tube addon listening on http://0.0.0.0:${port}`);
  console.log(`Open http://<host>:${port}/configure to set up Real-Debrid`);
  if (providers.length === 0) {
    console.warn('No search provider configured (ZILEAN_URL / TORZNAB_URL empty) — streams are limited to your cloud library.');
  }
});
