// Composition root: builds the app's long-lived services (caches, negative
// stores, torrent-index providers, search and meta services), lints the
// manifest once at startup, and hands them to `registerRoutes`. It never binds
// a port — the entry point (`index.ts`) does that so tests can build an app
// freely.
import express, { type Express } from 'express';
import { join } from 'node:path';
import { addonBuilder } from 'stremio-addon-sdk';

import type { Config, TorrentProvider } from './types.js';
import { createCaches } from './services/cache.js';
import { NegativeStore } from './services/negativeStore.js';
import { TmdbClient } from './services/tmdb.js';
import { ZileanProvider } from './services/zilean.js';
import { PirateBayProvider } from './services/piratebay.js';
import { YtsProvider } from './services/yts.js';
import { TorznabProvider } from './services/torznab.js';
import { SearchService } from './services/search.js';
import { MetaService } from './meta/meta.js';
import { buildManifest } from './manifest.js';
import { registerRoutes } from './routes.js';

/**
 * Build a fully wired Express app for the given configuration.
 * Long-lived services are created here; request-scoped debrid clients are
 * created per request inside the route handlers.
 */
export function createApp(config: Config): Express {
  const caches = createCaches(config.cacheTtlSeconds);

  // Persisted stores of torrent hashes the debrid provider blocked as
  // infringing — Real-Debrid and TorBox keep separate files.
  const negativeStore = new NegativeStore(join(config.dataDir, 'blocked-hashes.json'));
  const torboxNegatives = new NegativeStore(join(config.dataDir, 'torbox-blocked-hashes.json'));

  // Lint the manifest once at startup for early feedback (warnings only; never fatal).
  try {
    new addonBuilder(buildManifest(config, 'http://localhost') as never);
  } catch (err) {
    console.error('Manifest lint error:', err);
  }

  // Optional TMDB enrichment feeds the meta service; without a key only the
  // free Cinemeta fallback is used.
  const tmdb = config.tmdbApiKey ? new TmdbClient(config.tmdbApiKey) : null;
  const metaService = new MetaService(tmdb, caches);

  // Torrent indexes, queried in order. Zilean and Torznab are opt-in; The
  // Pirate Bay and YTS are always registered so search has at least one backend.
  const providers: TorrentProvider[] = [];
  if (config.zileanUrl) providers.push(new ZileanProvider(config.zileanUrl, config.zileanApiKey ?? undefined));
  providers.push(new PirateBayProvider());
  providers.push(new YtsProvider());
  if (config.torznabUrl && config.torznabApiKey) {
    providers.push(new TorznabProvider(config.torznabUrl, config.torznabApiKey));
  }
  const searchService = new SearchService(providers, caches);

  const app = express();
  registerRoutes(app, {
    config,
    caches,
    negativeStore,
    torboxNegatives,
    metaService,
    searchService,
  });
  return app;
}
