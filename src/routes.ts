// HTTP layer for Tube. Every Express middleware and Stremio-protocol route
// (manifest / catalog / meta / stream) plus the `/configure` page lives here so
// the entry point stays small and each section reads top-down.
//
// Long-lived services are built once in `app.ts` and handed in as `AppDeps`;
// everything request-scoped (the per-token debrid client) is constructed inside
// the handlers, because the token is embedded in the URL path by the client.
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from './types.js';
import type { ContentType, Meta } from './stremio.js';
import { CINEMETA_TIMEOUT_MS, DOWNLOADS_CATALOG, LIBRARY_CATALOG, SEARCH_CATALOG } from './constants.js';
import { buildManifest } from './manifest.js';
import { renderConfigurePage } from './configure.js';
import { RealDebridError } from './services/realdebrid.js';
import { createDebridClient, preferredLanguages } from './services/debrid.js';
import { CachedRealDebrid } from './services/cachedRd.js';
import type { CacheSet } from './services/cache.js';
import type { SearchService } from './services/search.js';
import type { MetaService } from './meta/meta.js';
import type { NegativeStore } from './services/negativeStore.js';
import { LibraryCatalog } from './catalogs/library.js';
import { SearchCatalog } from './catalogs/search.js';
import { StreamResolver } from './stream/resolver.js';
import { TtStreamProvider } from './stream/tt.js';

/** Services shared by every request; created once in `app.ts`. */
export interface AppDeps {
  config: Config;
  caches: CacheSet;
  /** Persisted blocked-hash store for Real-Debrid accounts. */
  negativeStore: NegativeStore;
  /** Persisted blocked-hash store for TorBox accounts (kept separate). */
  torboxNegatives: NegativeStore;
  metaService: MetaService;
  searchService: SearchService;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Mount every route on `app`. Handlers close over the shared `deps`. */
export function registerRoutes(app: Express, deps: AppDeps): void {
  const { config, caches, negativeStore, torboxNegatives, metaService, searchService } = deps;

  // ------------------------------------------------------------------ helpers

  /**
   * Absolute base URL for building self-referential manifest/static links.
   * Prefers the configured `BASE_URL` (trailing slash stripped); otherwise
   * reconstructs it from the request, honoring the left-most `X-Forwarded-Proto`
   * value so links stay correct behind a reverse proxy.
   */
  const requestBaseUrl = (req: Request): string => {
    if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
  };

  /**
   * Resolves the debrid credential for a request from, in order: the `:token`
   * path segment (already URL-decoded by Express — do NOT decode again, or a
   * token containing a literal `%` would be corrupted), the `?apiKey=` query
   * param, or `RD_API_KEY`. Returns `null` when none is present, so callers can
   * redirect to `/configure`.
   */
  const resolveToken = (req: Request): string | null => {
    const pathToken = req.params.token;
    if (pathToken) return pathToken;
    const queryToken = req.query.apiKey;
    if (typeof queryToken === 'string' && queryToken) return queryToken;
    return config.rdApiKey;
  };

  /** Fresh TTL-cached debrid client for one request's credential. */
  const clientFor = (token: string): CachedRealDebrid =>
    new CachedRealDebrid(createDebridClient(token, config), caches);

  /** Per-request debrid client plus the catalog adapters built around it. */
  const catalogsFor = (token: string) => {
    const rd = clientFor(token);
    return {
      rd,
      library: new LibraryCatalog(rd, metaService),
      searchCatalog: new SearchCatalog(rd, searchService, metaService, caches, config.includeUncached),
    };
  };

  /**
   * Parses Stremio's `extra` path segment (a URL query string, sometimes with a
   * trailing `.json`) into `search` and `skip` for catalog filtering/paging.
   */
  const parseExtra = (raw: string): { search?: string; skip?: number } => {
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
  };

  /** Decodes a path segment and drops Stremio's trailing `.json` suffix. */
  const stripJson = (id: string): string => decodeURIComponent(id.replace(/\.json$/, ''));

  /**
   * Uniform error response. A 401 from the debrid maps to Stremio's
   * `invalid_token` code (prompting the client to re-open `/configure`);
   * anything else is logged server-side and returned as a generic 500.
   */
  const sendError = (res: Response, err: unknown): void => {
    if (err instanceof RealDebridError && err.status === 401) {
      res.status(401).json({ err: 'invalid_token', hint: 'Re-open /configure to update your token' });
      return;
    }
    console.error(err);
    res.status(500).json({ err: 'internal_error' });
  };

  /** Fetch Cinemeta's meta for a normal tt id and pass it through unchanged. */
  const proxyCinemetaMeta = async (type: ContentType, id: string): Promise<Meta | null> => {
    const ttId = id.split(':')[0];
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${ttId}.json`, {
        signal: AbortSignal.timeout(CINEMETA_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { meta?: Meta };
      return data.meta ?? null;
    } catch {
      return null;
    }
  };

  // -------------------------------------------------------------- middleware

  app.disable('x-powered-by');

  // Stremio fetches addons cross-origin, so every route answers CORS.
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

  // ------------------------------------------------------------------ pages

  app.get('/', (_req, res) => {
    res.redirect(307, '/configure');
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // The configure page is served both at the root and under a token path
  // (Stremio opens "Configure" relative to the addon URL).
  const configurePage = (req: Request, res: Response): void => {
    res.type('html').send(renderConfigurePage(requestBaseUrl(req)));
  };
  app.get('/configure', configurePage);
  app.get('/:token/configure', configurePage);

  app.use('/static', express.static(join(__dirname, '..', 'public')));

  // --------------------------------------------------------------- manifest

  /**
   * Serves the Stremio manifest. It is built per request because the provider
   * identity (RD vs TorBox) — and therefore the addon id/name and catalog set —
   * depends on the token. Without a token, redirect to `/configure` so Stremio's
   * "Configure" flow can collect one.
   */
  const manifestHandler = (req: Request, res: Response): void => {
    const token = resolveToken(req);
    if (!token) {
      res.redirect(307, '/configure');
      return;
    }
    const provider = createDebridClient(token, config).provider;
    res.type('application/json').send(buildManifest(config, requestBaseUrl(req), provider));
  };
  // Both mount points: the bare path (token via query/env) and the token-in-path
  // form Stremio installs.
  app.get('/manifest.json', manifestHandler);
  app.get('/:token/manifest.json', manifestHandler);

  // ---------------------------------------------------------------- catalog

  /**
   * Serves library/downloads/search catalogs. A fresh debrid client is built per
   * request from the token; `SEARCH_CATALOG` queries the torrent index while
   * `LIBRARY_CATALOG` / `DOWNLOADS_CATALOG` list the user's debrid cloud. Unknown
   * ids resolve to an empty list so Stremio's discovery browsing stays quiet.
   */
  const catalogHandler = (req: Request, res: Response): void => {
    const token = resolveToken(req);
    if (!token) {
      res.status(401).json({ err: 'missing_token', hint: 'Open /configure to set your Real-Debrid token' });
      return;
    }
    const { library, searchCatalog } = catalogsFor(token);

    const type = stripJson(req.params.type) as ContentType;
    const id = stripJson(req.params.id);
    const extra = parseExtra(req.params.extra ?? '');
    const baseUrl = requestBaseUrl(req);

    const promise = (() => {
      if (id === SEARCH_CATALOG) return searchCatalog.catalog(type, extra.search, baseUrl);
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
  };
  app.get('/:token/catalog/:type/:id', catalogHandler);
  app.get('/:token/catalog/:type/:id/:extra', catalogHandler);

  // -------------------------------------------------------------------- meta

  /**
   * Serves meta for OUR ids (`rd:` library, `sr:` search). Normal `tt` ids are
   * proxied to Cinemeta as a safety net (see below) so posters keep working even
   * if a client ignores the manifest's `idPrefixes`.
   */
  const metaHandler = (req: Request, res: Response): void => {
    const token = resolveToken(req);
    if (!token) {
      res.status(401).json({ err: 'missing_token' });
      return;
    }
    const { library, searchCatalog } = catalogsFor(token);

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
  };
  app.get('/:token/meta/:type/:id', metaHandler);

  // ------------------------------------------------------------------ stream

  /**
   * Resolves streams for a title. `tt` ids go through the full search path
   * (cloud + torrent index), while `rd:`/`sr:` ids resolve a specific stored item.
   * TorBox and Real-Debrid keep separate negative stores so a hash blocked on one
   * provider does not poison the other.
   */
  const streamHandler = (req: Request, res: Response): void => {
    const token = resolveToken(req);
    if (!token) {
      res.status(401).json({ err: 'missing_token' });
      return;
    }
    const rd = clientFor(token);
    const negatives = rd.provider === 'torbox' ? torboxNegatives : negativeStore;
    const langs = preferredLanguages(token);
    const resolver = new StreamResolver(rd, { search: searchService, caches, negatives, preferredLanguages: langs });
    const ttProvider = new TtStreamProvider(rd, caches, {
      search: searchService,
      negatives,
      preferredLanguages: langs,
      qualityFilters: {
        minQuality: config.minQuality ?? undefined,
        excludeQuality: config.excludeQuality,
      },
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
  };
  app.get('/:token/stream/:type/:id', streamHandler);

  // --------------------------------------------------- singleton (tokenless)

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

  // ---------------------------------------------------------- 404 & errors

  // JSON 404 for any unmatched route — Stremio clients expect JSON, not HTML.
  // (No path is echoed: the request path may carry the user's token.)
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ err: 'not_found' });
  });

  // Error middleware: normalize synchronous throws from handlers to JSON errors.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err);
  });
}
