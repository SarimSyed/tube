import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader so `npm run dev` works without extra dependencies.
 * Docker / docker-compose passes env directly and does not need this.
 */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env file — fine.
  }
}

loadDotEnv();

function env(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value === '') return null;
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === null) return fallback;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function envInt(name: string, fallback: number): number {
  const value = env(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): Config {
  return {
    port: envInt('PORT', 7000),
    baseUrl: env('BASE_URL') ?? '',
    rdApiKey: env('RD_API_KEY'),
    rdApiBase: env('RD_API_BASE'),
    torboxApiBase: env('TORBOX_API_BASE'),
    dataDir: env('DATA_DIR') ?? '/app/data',
    tmdbApiKey: env('TMDB_API_KEY'),
    zileanUrl: env('ZILEAN_URL'),
    zileanApiKey: env('ZILEAN_API_KEY'),
    torznabUrl: env('TORZNAB_URL'),
    torznabApiKey: env('TORZNAB_API_KEY'),
    cacheTtlSeconds: envInt('CACHE_TTL_SECONDS', 120),
    includeUncached: envBool('INCLUDE_UNCACHED', true),
    showLibraryCatalogs: envBool('SHOW_LIBRARY_CATALOGS', false),
    showSearchCatalogs: envBool('SHOW_SEARCH_CATALOGS', false),
    addonId: env('ADDON_ID') ?? 'community.tube',
    addonName: env('ADDON_NAME') ?? 'Tube (Real-Debrid)',
    addonDescription:
      env('ADDON_DESCRIPTION') ??
      'Real-Debrid streams on standard Stremio movie and episode pages, with optional cloud catalogs.',
    version: env('ADDON_VERSION') ?? '1.2.0',
  };
}
