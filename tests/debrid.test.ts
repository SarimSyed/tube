// Tests provider credential routing: createDebridClient (torbox: /
// torbox-download: / plain RD), the preferredLanguages suffix, and how the
// manifest differs between Real-Debrid and TorBox installs.
import { afterEach, expect, it, vi } from 'vitest';
import { createDebridClient, parseCredentialPrefs, preferredLanguages } from '../src/services/debrid.js';
import { buildManifest } from '../src/manifest.js';
import { loadConfig } from '../src/config.js';
import { CachedRealDebrid } from '../src/services/cachedRd.js';
import { createCaches } from '../src/services/cache.js';

afterEach(() => vi.unstubAllEnvs());

it('preserves TorBox download opt-in through the cached gateway without changing existing tokens', () => {
  const config = loadConfig();
  const cached = createDebridClient('torbox:example', config);
  const downloads = createDebridClient('torbox-download:example', config);
  expect(downloads.provider).toBe('torbox');
  expect(new CachedRealDebrid(downloads, createCaches(120)).allowUncached).toBe(true);
  expect(cached.allowUncached).toBe(false);
  expect(createDebridClient('example', config).allowUncached).not.toBe(true);
});

it('routes TorBox credentials separately and keeps existing RD installs compatible', () => {
  const config = loadConfig();
  expect(createDebridClient('torbox:example', config).provider).toBe('torbox');
  expect(createDebridClient('example', config).provider).toBe('realdebrid');
  expect(createDebridClient('example', config).cacheKey).not.toBe(createDebridClient('torbox:example', config).cacheKey);
});

it('gives TorBox its own addon identity and only supported catalogs', () => {
  vi.stubEnv('SHOW_LIBRARY_CATALOGS', '');
  vi.stubEnv('SHOW_SEARCH_CATALOGS', '');
  const config = loadConfig();
  const rd = buildManifest(config, 'http://localhost');
  const tb = buildManifest(config, 'http://localhost', 'torbox');
  expect(tb.id).not.toBe(rd.id);
  expect(tb.name).toContain('TorBox');
  expect(tb.catalogs).toEqual([]);
  expect(tb.catalogs.some((c: any) => c.id === 'rd-search')).toBe(false);
});

it.each(['realdebrid', 'torbox'])('contributes streams to standard titles without separate search rows (%s)', (provider) => {
  vi.stubEnv('SHOW_LIBRARY_CATALOGS', '');
  vi.stubEnv('SHOW_SEARCH_CATALOGS', '');
  const config = loadConfig();
  const manifest = buildManifest(config, 'http://localhost', provider);
  expect(config.showLibraryCatalogs).toBe(false);
  expect(config.showSearchCatalogs).toBe(false);
  expect(manifest.catalogs).toEqual([]);
  expect(manifest.resources).toContainEqual({ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'rd:', 'sr:'] });
  expect(manifest.resources).not.toContainEqual({ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] });
});

it.each(['realdebrid', 'torbox'])('allows library and advanced search catalogs to be enabled independently (%s)', (provider) => {
  vi.stubEnv('SHOW_LIBRARY_CATALOGS', 'true');
  vi.stubEnv('SHOW_SEARCH_CATALOGS', 'false');
  const library = buildManifest(loadConfig(), 'http://localhost', provider);
  expect(library.catalogs.map((c: any) => c.id)).toEqual(provider === 'torbox'
    ? ['rd-library', 'rd-library'] : ['rd-library', 'rd-library', 'rd-downloads', 'rd-downloads']);
  vi.stubEnv('SHOW_LIBRARY_CATALOGS', 'false');
  vi.stubEnv('SHOW_SEARCH_CATALOGS', 'true');
  const search = buildManifest(loadConfig(), 'http://localhost', provider);
  expect(search.catalogs.map((c: any) => c.id)).toEqual(['rd-search', 'rd-search']);
});


it('parses preferred languages from the credential suffix and keeps providers working', () => {
  expect(preferredLanguages('torbox:tok~hindi,tamil')).toEqual(['hindi', 'tamil']);
  expect(preferredLanguages('torbox-download:tok~hindi')).toEqual(['hindi']);
  expect(preferredLanguages('tok')).toEqual([]);

  const config = loadConfig();
  expect(createDebridClient('torbox:tok~hindi,tamil', config).provider).toBe('torbox');
  expect(createDebridClient('torbox-download:tok~hindi', config).allowUncached).toBe(true);
  expect(createDebridClient('tok~hindi', config).provider).toBe('realdebrid');
});

it('parses per-install network profile knobs from the credential suffix', () => {
  expect(parseCredentialPrefs('torbox:tok~hindi,tamil;maxres=1080p;maxgb=2')).toEqual({
    languages: ['hindi', 'tamil'],
    maxResolution: '1080p',
    maxSizeBytes: 2 * 1024 ** 3,
  });
  // Old installs without profile knobs still parse as before.
  expect(parseCredentialPrefs('torbox-download:tok~hindi')).toEqual({ languages: ['hindi'] });
  expect(parseCredentialPrefs('tok')).toEqual({ languages: [] });
  // Case-insensitive and fractionally-sized caps.
  expect(parseCredentialPrefs('tok~maxres=720P;maxgb=1.5')).toEqual({
    languages: [], maxResolution: '720p', maxSizeBytes: Math.round(1.5 * 1024 ** 3),
  });
  // Only the language section feeds preferredLanguages; profile knobs are kept apart.
  expect(preferredLanguages('tok~hindi;maxres=1080p')).toEqual(['hindi']);
  // Garbage values are ignored rather than applied.
  expect(parseCredentialPrefs('tok~maxres=8k-ultra;maxgb=banana')).toEqual({ languages: [] });
});
