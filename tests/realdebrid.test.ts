// Tests RealDebridClient HTTP behavior with a stubbed global fetch: bearer auth,
// 401 -> InvalidTokenError mapping, batched instant availability, and the
// form-encoded addMagnet body.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealDebridClient, InvalidTokenError } from '../src/services/realdebrid.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RealDebridClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists torrents', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'T1', filename: 'a.mkv', hash: 'h1' }]));
    const client = new RealDebridClient('token');
    const list = await client.listTorrents();
    expect(list).toEqual([{ id: 'T1', filename: 'a.mkv', hash: 'h1' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/torrents?limit=2500'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    );
  });

  it('throws InvalidTokenError on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad_token' }, 401));
    const client = new RealDebridClient('bad');
    await expect(client.listTorrents()).rejects.toThrow(InvalidTokenError);
  });

  it('batches instant availability and returns cached hashes', async () => {
    const body = {
      aaaa: { rd: [{ filename: 'a.mkv', filesize: 1 }] },
      bbbb: {},
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const client = new RealDebridClient('token');
    const cached = await client.instantAvailability(['aaaa', 'bbbb']);
    expect(cached.has('aaaa')).toBe(true);
    expect(cached.has('bbbb')).toBe(false);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/instantAvailability/aaaa/bbbb');
  });

  it('adds a magnet with form body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'T2', uri: 'magnet:?xt=urn:btih:aaaa' }));
    const client = new RealDebridClient('token');
    const res = await client.addMagnet('magnet:?xt=urn:btih:aaaa');
    expect(res.id).toBe('T2');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('magnet=');
  });
});
