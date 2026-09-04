import type { RdDownload, RdTorrent, RdTorrentSummary } from '../types.js';
import { createHash } from 'node:crypto';

const DEFAULT_BASE = 'https://api.real-debrid.com/rest/1.0';

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

export class InvalidTokenError extends RealDebridError {
  constructor() {
    super('Invalid or expired Real-Debrid API token', 401);
    this.name = 'InvalidTokenError';
  }
}

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
  readonly allowUncached?: boolean;
  readonly cacheKey?: string;
  getUser(): Promise<{ id: number | string; username: string }>;
  listTorrents(): Promise<RdTorrentSummary[]>;
  getTorrentInfo(id: string): Promise<RdTorrent>;
  listDownloads(): Promise<RdDownload[]>;
  addMagnet(magnet: string, cachedOnly?: boolean): Promise<{ id: string; uri: string }>;
  selectAllFiles(torrentId: string): Promise<void>;
  deleteTorrent(torrentId: string): Promise<void>;
  /** Convert an RD download link (landing page) into a direct playable file URL. */
  unrestrict(link: string): Promise<{ download: string; filename: string }>;
  /** Set of cached hashes, or `null` when availability is unknown (endpoint disabled). */
  instantAvailability(hashes: string[]): Promise<Set<string> | null>;
}

function formBody(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data);
}

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
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
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

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class RealDebridClient implements RdGateway {
  readonly provider = 'realdebrid';
  readonly cacheKey: string;
  constructor(
    private token: string,
    private baseUrl: string = DEFAULT_BASE,
  ) {
    this.cacheKey = createHash('sha256').update(`${baseUrl}\0${token}`).digest('hex');
  }

  async getUser(): Promise<{ id: number; username: string }> {
    return rdFetch<{ id: number; username: string }>(this.baseUrl, this.token, '/user');
  }

  async listTorrents(): Promise<RdTorrentSummary[]> {
    return rdFetch<RdTorrentSummary[]>(this.baseUrl, this.token, '/torrents?limit=2500');
  }

  async getTorrentInfo(id: string): Promise<RdTorrent> {
    return rdFetch<RdTorrent>(this.baseUrl, this.token, `/torrents/info/${encodeURIComponent(id)}`);
  }

  async listDownloads(): Promise<RdDownload[]> {
    return rdFetch<RdDownload[]>(this.baseUrl, this.token, '/downloads?limit=2500');
  }

  async addMagnet(magnet: string): Promise<{ id: string; uri: string }> {
    return rdFetch<{ id: string; uri: string }>(this.baseUrl, this.token, '/torrents/addMagnet', {
      method: 'POST',
      body: formBody({ magnet }),
    });
  }

  async selectAllFiles(torrentId: string): Promise<void> {
    await rdFetch<void>(this.baseUrl, this.token, `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, {
      method: 'POST',
      body: formBody({ files: 'all' }),
    });
  }

  async unrestrict(link: string): Promise<{ download: string; filename: string }> {
    return rdFetch<{ download: string; filename: string }>(this.baseUrl, this.token, '/unrestrict/link', {
      method: 'POST',
      body: formBody({ link }),
    });
  }

  async deleteTorrent(torrentId: string): Promise<void> {
    await rdFetch<void>(this.baseUrl, this.token, `/torrents/delete/${encodeURIComponent(torrentId)}`, {
      method: 'DELETE',
    });
  }

  /** Batched instant-availability check. Returns the hashes RD already has cached. */
  async instantAvailability(hashes: string[]): Promise<Set<string>> {
    const cached = new Set<string>();
    if (hashes.length === 0) return cached;

    const CHUNK = 100;
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const batch = hashes.slice(i, i + CHUNK);
      const path = `/torrents/instantAvailability/${batch.join('/')}`;
      const data = await rdFetch<Record<string, { rd?: unknown[] }>>(this.baseUrl, this.token, path);
      for (const hash of batch) {
        const entry = data[hash.toLowerCase()] ?? data[hash.toUpperCase()];
        if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) cached.add(hash.toLowerCase());
      }
    }
    return cached;
  }
}
