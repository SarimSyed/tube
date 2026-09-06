// HTTP-level tests against the exported Express app. Importing `src/index.js`
// must NOT bind the configured port (that only happens when index.ts is the
// entry module), so this file can start the app itself on an ephemeral port.
// These cover server-level behaviors that unit tests cannot reach: JSON error
// bodies, the health endpoint, and the security posture of the tokenless
// (RD_API_KEY singleton) routes, which must not be exposed when no key is set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../src/index.js';

let server: Server;
let base: string;

beforeAll(async () => {
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

async function get(path: string): Promise<{ status: number; json: unknown; contentType: string | null }> {
  const res = await fetch(base + path, { redirect: 'manual' });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, contentType: res.headers.get('content-type') };
}

describe('Tube HTTP server', () => {
  it('serves /healthz as ok', async () => {
    const r = await get('/healthz');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  it('returns a JSON body for unknown routes (not Express HTML)', async () => {
    const r = await get('/definitely-not-a-route');
    expect(r.status).toBe(404);
    expect(r.contentType).toContain('application/json');
    expect(r.json).toEqual({ err: 'not_found' });
  });

  it('does not expose tokenless resource routes when no singleton key is set', async () => {
    // Without RD_API_KEY the addon is token-in-URL only; a tokenless request to a
    // catalog/meta/stream endpoint must 404 rather than touch the debrid API.
    expect((await get('/stream/movie/tt123456')).status).toBe(404);
    expect((await get('/catalog/movie/rd-search')).status).toBe(404);
    expect((await get('/meta/movie/rd:1')).status).toBe(404);
  });

  it('redirects a tokenless manifest to /configure when no singleton key is set', async () => {
    const res = await fetch(`${base}/manifest.json`, { redirect: 'manual' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/configure');
  });
});
