// B5 coverage: with a server-side RD_API_KEY singleton, tokenless resource
// routes must be reachable so a tokenless `/manifest.json` install works end to
// end. We point RD at a closed local port so the request fails fast (proving the
// route is mounted — it returns a 500, not a 404) without any real debrid call.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;

beforeAll(async () => {
  // Singleton key set, debrid base pointed at a closed port for a quick refusal.
  const app = createApp({
    port: 7000,
    rdApiBase: 'http://127.0.0.1:9',
    torboxApiBase: null,
    dataDir: '/tmp',
    baseUrl: 'http://localhost:7000',
    rdApiKey: 'singleton-test-key',
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
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(base + path, { redirect: 'manual' });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json };
}

describe('Tube singleton mode (RD_API_KEY set)', () => {
  it('serves the manifest tokenlessly', async () => {
    const r = await get('/manifest.json');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 'community.tube' });
  });

  it('mounts tokenless catalog/meta/stream routes (reached, backend unreachable -> 500 not 404)', async () => {
    // A 500 (backend failure) proves the route is wired; a 404 would mean the
    // singleton routes were not registered.
    expect((await get('/catalog/movie/rd-library')).status).toBe(500);
    expect((await get('/meta/movie/rd:1')).status).toBe(500);
  });
});

describe('Explicit download route (tokenless, TorBox download install)', () => {
  let dlServer: Server;
  let dlBase: string;
  let mockProvider: Server;

  beforeAll(async () => {
    // A tiny local TorBox stand-in that accepts any createtorrent call.
    mockProvider = createServer((_req: unknown, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { torrent_id: 123 } }));
    });
    await new Promise<void>((resolve) => mockProvider.listen(0, () => resolve()));
    const maddr = mockProvider.address() as { port: number };

    const app = createApp({
      port: 7000,
      rdApiBase: null,
      torboxApiBase: `http://127.0.0.1:${maddr.port}`,
      dataDir: '/tmp',
      baseUrl: 'http://localhost:7000',
      rdApiKey: 'torbox-download:test-key',
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
      logRequests: false,
      addonId: 'community.tube',
      addonName: 'Tube (TorBox)',
      addonDescription: 'desc',
      version: '1.0.0',
    });
    await new Promise<void>((resolve) => { dlServer = app.listen(0, () => resolve()); });
    const addr = dlServer.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    dlBase = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => dlServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
  });

  it('queues a valid hash and acknowledges without redirecting out of Stremio', async () => {
    const res = await fetch(`${dlBase}/download?hash=${'a'.repeat(40)}`, { redirect: 'manual' });
    expect(res.status).toBe(202);
    expect(res.headers.get('location')).toBeNull(); // never opens the dashboard
    const body = await res.json() as { queued?: boolean };
    expect(body.queued).toBe(true);
  });

  it('rejects a malformed hash', async () => {
    const res = await fetch(`${dlBase}/download?hash=not-a-hash`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });
});
