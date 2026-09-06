// B5 coverage: with a server-side RD_API_KEY singleton, tokenless resource
// routes must be reachable so a tokenless `/manifest.json` install works end to
// end. We point RD at a closed local port so the request fails fast (proving the
// route is mounted — it returns a 500, not a 404) without any real debrid call.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

describe('Tube singleton mode (RD_API_KEY set)', () => {
  let server: Server;
  let base: string;
  let app: { listen: (...args: unknown[]) => Server };

  beforeAll(async () => {
    // Load the app fresh with the singleton key + an unreachable RD base so any
    // backend call fails fast and locally.
    vi.resetModules();
    process.env.RD_API_KEY = 'singleton-test-key';
    process.env.RD_API_BASE = 'http://127.0.0.1:9'; // closed port -> quick refusal
    const mod = await import('../src/index.js') as { app: { listen: (...args: unknown[]) => Server } };
    app = mod.app;
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.RD_API_KEY;
    delete process.env.RD_API_BASE;
  });

  async function get(path: string): Promise<{ status: number; json: unknown }> {
    const res = await fetch(base + path, { redirect: 'manual' });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json };
  }

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
