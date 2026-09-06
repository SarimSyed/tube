// Guard tests for buildManifest's per-provider catalog set: Real-Debrid keeps
// Library + Downloads + Search, TorBox keeps Library + Search (no hoster
// Downloads) and TB-prefixed names. These pin the existing behavior so a
// catalog-toggle regression is caught.
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../src/manifest.js';
import type { Config } from '../src/types.js';

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 7000,
    rdApiBase: null,
    torboxApiBase: null,
    dataDir: '/tmp',
    baseUrl: 'http://localhost:7000',
    rdApiKey: null,
    tmdbApiKey: null,
    zileanUrl: null,
    zileanApiKey: null,
    torznabUrl: null,
    torznabApiKey: null,
    cacheTtlSeconds: 120,
    includeUncached: true,
    minQuality: null,
    excludeQuality: [],
    showLibraryCatalogs: false,
    showSearchCatalogs: false,
    addonId: 'community.tube',
    addonName: 'Tube (Real-Debrid)',
    addonDescription: 'desc',
    version: '1.0.0',
    ...overrides,
  };
}

describe('buildManifest catalog sets', () => {
  it('gives Real-Debrid library and downloads catalogs when the library toggle is on', () => {
    const m = buildManifest(cfg({ showLibraryCatalogs: true }), 'http://localhost');
    const names = m.catalogs.map((c) => (c as { name: string }).name);
    expect(names).toContain('RD Library');
    expect(names).toContain('RD Downloads');
    expect(names).not.toContain('RD Search');
  });

  it('gives TorBox a TB Library but no hoster downloads catalog', () => {
    const m = buildManifest(cfg({ showLibraryCatalogs: true }), 'http://localhost', 'torbox');
    const names = m.catalogs.map((c) => (c as { name: string }).name);
    expect(names).toContain('TB Library');
    expect(names).not.toContain('RD Downloads');
    expect(names).not.toContain('TB Downloads');
  });

  it('hides both library and search catalogs when their toggles are off', () => {
    const m = buildManifest(cfg({}), 'http://localhost');
    expect(m.catalogs).toEqual([]);
  });

  it('uses a distinct TorBox addon id and display name', () => {
    const m = buildManifest(cfg(), 'http://localhost', 'torbox');
    expect(m.id).toBe('community.tube.torbox');
    expect(m.name).toBe('Tube (TorBox)');
  });
});
