import { createHash } from 'node:crypto';
import { RealDebridError, type RdGateway } from './realdebrid.js';

// Pace TorBox API calls (shared across client instances) to avoid HTTP 429.
let lastTorBoxRequest = 0;
import type { RdTorrent } from '../types.js';

interface TorBoxTorrent {
  id: number;
  name: string;
  hash: string;
  size: number;
  progress: number;
  created_at: string;
  download_finished: boolean;
  download_present: boolean;
  download_state: string;
  files?: Array<{ id: number; name: string; short_name?: string; size: number }>;
  seeders?: number;
}

/** Adapt TorBox's torrent API to the existing cloud/stream pipeline. */
export class TorBoxClient implements RdGateway {
  readonly provider = 'torbox';
  readonly cacheKey: string;
  constructor(private token: string, private baseUrl = 'https://api.torbox.app/v1/api', readonly allowUncached = false) {
    this.cacheKey = createHash('sha256').update(`torbox\0${baseUrl}\0${token}`).digest('hex');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      const wait = lastTorBoxRequest + 120 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastTorBoxRequest = Date.now();
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
      });
    } catch {
      throw new RealDebridError('Could not reach the TorBox API', 502);
    }
    // Do not log URLs or arbitrary response details: requestdl carries the token.
    if (!response.ok) throw new RealDebridError(`TorBox API error ${response.status}`, response.status);
    const body = await response.json() as { success: boolean; data: T; error?: string };
    if (!body.success) {
      const code = typeof body.error === 'string' && /^[A-Z_]{1,50}$/.test(body.error) ? body.error : 'REQUEST_FAILED';
      throw new RealDebridError(`TorBox API error: ${code}`, code === 'AUTH_ERROR' ? 401 : 400);
    }
    return body.data;
  }

  private torrent(t: TorBoxTorrent): RdTorrent {
    const ready = t.download_finished && t.download_present;
    const files = (t.files ?? []).map(f => ({ id: f.id, path: f.name, bytes: f.size, selected: 1 }));
    return {
      id: String(t.id), filename: t.name, hash: t.hash, bytes: t.size,
      status: ready ? 'downloaded' : 'downloading', progress: t.progress * 100, added: t.created_at,
      seeders: typeof t.seeders === 'number' ? t.seeders : undefined,
      files,
      // Internal file references carry no credentials; unrestrict resolves them.
      links: ready ? files.map(f => `torbox://${t.id}/${f.id}/${encodeURIComponent(f.path.split('/').pop() ?? f.path)}`) : [],
    };
  }

  async getUser(): Promise<{ id: number | string; username: string }> {
    const user = await this.request<{ id: number | string; email: string }>('/user/me');
    return { id: user.id, username: user.email };
  }

  async listTorrents() {
    const torrents = await this.request<TorBoxTorrent[]>('/torrents/mylist?bypass_cache=true');
    return (torrents ?? []).map(t => this.torrent(t));
  }

  async getTorrentInfo(id: string): Promise<RdTorrent> {
    const torrent = await this.request<TorBoxTorrent>(`/torrents/mylist?${new URLSearchParams({ id, bypass_cache: 'true' })}`);
    if (!torrent || String(torrent.id) !== id) throw new RealDebridError('TorBox torrent not found', 404);
    return this.torrent(torrent);
  }

  async addMagnet(magnet: string, cachedOnly = true) {
    const body = new FormData();
    body.set('magnet', magnet);
    body.set('add_only_if_cached', String(cachedOnly || !this.allowUncached));
    const result = await this.request<{ torrent_id?: number } | null>('/torrents/createtorrent', { method: 'POST', body });
    // A successful queued response may not yet have an active torrent ID.
    if (!Number.isInteger(result?.torrent_id) && this.allowUncached && !cachedOnly) return { id: '', uri: magnet };
    if (!Number.isInteger(result?.torrent_id)) throw new RealDebridError('TorBox torrent is queued or unavailable; check your TorBox dashboard', 409);
    return { id: String(result!.torrent_id), uri: magnet };
  }

  async selectAllFiles(): Promise<void> { /* TorBox selects files during creation. */ }
  async listDownloads() { return []; } // Torrent integration; no web-download catalog.

  async deleteTorrent(id: string): Promise<void> {
    await this.request('/torrents/controltorrent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrent_id: Number(id), operation: 'delete' }),
    });
  }

  async unrestrict(link: string) {
    const ref = new URL(link);
    const [fileId, filename] = ref.pathname.slice(1).split('/');
    if (ref.protocol !== 'torbox:' || !/^\d+$/.test(ref.hostname) || !/^\d+$/.test(fileId)) {
      throw new Error('Invalid TorBox file reference');
    }
    const query = new URLSearchParams({ token: this.token, torrent_id: ref.hostname, file_id: fileId, redirect: 'false' });
    const download = await this.request<string>(`/torrents/requestdl?${query}`);
    return { download, filename: decodeURIComponent(filename ?? '') };
  }

  async instantAvailability(hashes: string[]): Promise<Set<string>> {
    const cached = new Set<string>();
    for (let i = 0; i < hashes.length; i += 100) {
      const query = new URLSearchParams({ hash: hashes.slice(i, i + 100).join(','), format: 'list', list_files: 'false' });
      const rows = await this.request<Array<{ hash: string }>>(`/torrents/checkcached?${query}`);
      for (const row of rows ?? []) if (row.hash) cached.add(row.hash.toLowerCase());
    }
    return cached;
  }
}
