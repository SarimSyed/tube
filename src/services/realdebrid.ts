// Real-Debrid REST client. Every method maps to a `/rest/1.0` endpoint and
// sends the API token as a `Bearer` Authorization header; non-2xx responses
// surface as `RealDebridError` subclasses so callers can branch on them.
import type { RdDownload, RdTorrent, RdTorrentSummary } from '../types.js';
import { createHash } from 'node:crypto';
import { RD_TIMEOUT_MS } from '../constants.js';

// Real-Debrid REST API root (overridable via config for tests/mocks).
const DEFAULT_BASE = 'https://api.real-debrid.com/rest/1.0';

/** Error carrying an RD HTTP status (and optional `error_code`) for callers to branch on. */
export class RealDebridError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'RealDebridError';
    this.status = status;
    this.code = code;
  }
}

/** Raised when RD rejects the token with `401`. */
export class InvalidTokenError extends RealDebridError {
  constructor() {
    super('Invalid or expired Real-Debrid API token', 401);
    this.name = 'InvalidTokenError';
  }
}

/**
 * True when `err` means RD blocked the file as infringing — status `451`,
 * error_code `35`, or an "infringing_file" message. Such hashes are persisted
 * (see `NegativeStore`) so the addon never tries them again.
 */
export function isBlockedFileError(err: unknown): boolean {
  return (err instanceof RealDebridError && (err.status === 451 || err.code === '35'))
    || (err instanceof Error && /\binfringing_file\b/.test(err.message));
}

/** Raised when RD reports an endpoint disabled for this account (error_code 37). */
export class EndpointDisabledError extends RealDebridError {
  constructor() {
    super('This Real-Debrid endpoint is disabled for your account (disabled_endpoint)', 403, 'disabled_endpoint');
    this.name = 'EndpointDisabledError';
  }
}

/** Interface so callers can use a TTL-cached wrapper interchangeably. */
export interface RdGateway {
  readonly provider?: 'realdebrid' | 'torbox';
  /** Whether the client may queue uncached magnets (TorBox `torbox-download:` mode). */
  readonly allowUncached?: boolean;
  /** Opaque per-account key used to namespace TTL cache entries. */
  readonly cacheKey?: string;
  /** Account id and username/email for this token. */
  getUser(): Promise<{ id: number | string; username: string }>;
  /** All torrents in the debrid cloud (or adapted equivalent). */
  listTorrents(): Promise<RdTorrentSummary[]>;
  /** Full status and files for one torrent. */
  getTorrentInfo(id: string): Promise<RdTorrent>;
  /** Unrestricted hoster downloads in the account. */
  listDownloads(): Promise<RdDownload[]>;
  /**
   * Add a magnet link. `cachedOnly` limits the submit to already-cached content
   * where the provider supports it; resolves to the new torrent id and uri.
   */
  addMagnet(magnet: string, cachedOnly?: boolean): Promise<{ id: string; uri: string }>;
  /** Select all files so a freshly added torrent becomes downloadable. */
  selectAllFiles(torrentId: string): Promise<void>;
  deleteTorrent(torrentId: string): Promise<void>;
  /** Convert an RD download link (landing page) into a direct playable file URL. */
  unrestrict(link: string): Promise<{ download: string; filename: string }>;
  /** Set of cached hashes, or `null` when availability is unknown (endpoint disabled). */
  instantAvailability(hashes: string[]): Promise<Set<string> | null>;
}

// RD expects form-encoded POST bodies rather than JSON.
function formBody(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data);
}

/**
 * Shared GET/POST helper for the Real-Debrid REST API. Sends the token as a
 * `Bearer` Authorization header (plus form-encoded content type for bodies) and
 * maps failures to `RealDebridError` subclasses. On success, parses the JSON
 * body — or returns `undefined` for an empty `204` response.
 */
async function rdFetch<T>(
  base: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      // Real-Debrid can stall; abort after 15s if the caller didn't supply a signal.
      signal: init?.signal ?? AbortSignal.timeout(RD_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new RealDebridError('Real-Debrid API request timed out', 504);
    }
    throw new RealDebridError('Could not reach the Real-Debrid API', 502);
  }

  if (res.status === 401) throw new InvalidTokenError();
  if (res.status === 429) throw new RealDebridError('Real-Debrid rate limit exceeded', 429);

  if (!res.ok) {
    // Parse the RD error body so a valid token hitting a disabled endpoint is
    // reported correctly instead of being mistaken for a bad token.
    let error = '';
    let errorCode: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; error_code?: number | string };
      error = body.error ?? '';
      errorCode = body.error_code != null ? String(body.error_code) : undefined;
    } catch {
      // Not JSON — ignore.
    }
    if (res.status === 403 && (error === 'disabled_endpoint' || errorCode === '37')) {
      throw new EndpointDisabledError();
    }
    throw new RealDebridError(
      `Real-Debrid API error ${res.status}${error ? `: ${error}` : ''}`,
      res.status,
      errorCode,
    );
  }

  // 204 No Content (e.g. delete) — nothing to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Thin HTTP client over the Real-Debrid `/rest/1.0` API. Immutable per
 * token/base URL; `cacheKey` is a hash of both so per-account caches stay
 * separate even when the process serves multiple installs.
 */
export class RealDebridClient implements RdGateway {
  readonly provider = 'realdebrid';
  readonly cacheKey: string;
  constructor(
    private token: string,
    private baseUrl: string = DEFAULT_BASE,
  ) {
    this.cacheKey = createHash('sha256').update(`${baseUrl}\0${token}`).digest('hex');
  }

  /** `GET /user` — account id and username for this token. */
  async getUser(): Promise<{ id: number; username: string }> {
    return rdFetch<{ id: number; username: string }>(this.baseUrl, this.token, '/user');
  }

  /** `GET /torrents` — all torrents in the cloud (up to 2500). */
  async listTorrents(): Promise<RdTorrentSummary[]> {
    return rdFetch<RdTorrentSummary[]>(this.baseUrl, this.token, '/torrents?limit=2500');
  }

  /** `GET /torrents/info/{id}` — full status/files for one torrent. */
  async getTorrentInfo(id: string): Promise<RdTorrent> {
    return rdFetch<RdTorrent>(this.baseUrl, this.token, `/torrents/info/${encodeURIComponent(id)}`);
  }

  /** `GET /downloads` — unrestricted hoster downloads in the account (up to 2500). */
  async listDownloads(): Promise<RdDownload[]> {
    return rdFetch<RdDownload[]>(this.baseUrl, this.token, '/downloads?limit=2500');
  }

  /** `POST /torrents/addMagnet` — submit a magnet link; resolves to its torrent id. */
  async addMagnet(magnet: string): Promise<{ id: string; uri: string }> {
    return rdFetch<{ id: string; uri: string }>(this.baseUrl, this.token, '/torrents/addMagnet', {
      method: 'POST',
      body: formBody({ magnet }),
    });
  }

  /** `POST /torrents/selectFiles/{id}` — select all files so the torrent is downloadable. */
  async selectAllFiles(torrentId: string): Promise<void> {
    await rdFetch<void>(this.baseUrl, this.token, `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, {
      method: 'POST',
      body: formBody({ files: 'all' }),
    });
  }

  /** `POST /unrestrict/link` — resolve a landing/download page into a direct file URL. */
  async unrestrict(link: string): Promise<{ download: string; filename: string }> {
    return rdFetch<{ download: string; filename: string }>(this.baseUrl, this.token, '/unrestrict/link', {
      method: 'POST',
      body: formBody({ link }),
    });
  }

  /** `DELETE /torrents/delete/{id}` — remove a torrent from the cloud. */
  async deleteTorrent(torrentId: string): Promise<void> {
    await rdFetch<void>(this.baseUrl, this.token, `/torrents/delete/${encodeURIComponent(torrentId)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Batched `GET /torrents/instantAvailability/{hash}/{hash}/…` (100 hashes per
   * call). Returns the hashes RD already has cached, lowercased for consistency.
   */
  async instantAvailability(hashes: string[]): Promise<Set<string>> {
    const cached = new Set<string>();
    if (hashes.length === 0) return cached;

    const CHUNK = 100;
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const batch = hashes.slice(i, i + CHUNK);
      const path = `/torrents/instantAvailability/${batch.join('/')}`;
      const data = await rdFetch<Record<string, { rd?: unknown[] }>>(this.baseUrl, this.token, path);
      for (const hash of batch) {
        // RD keys the response by hash but not consistently by case, so check both.
        const entry = data[hash.toLowerCase()] ?? data[hash.toUpperCase()];
        if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) cached.add(hash.toLowerCase());
      }
    }
    return cached;
  }
}
