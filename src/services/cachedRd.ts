import type { RdDownload, RdTorrent, RdTorrentSummary } from '../types.js';
import { EndpointDisabledError, type RdGateway } from './realdebrid.js';
import type { CacheSet } from './cache.js';
import { randomUUID } from 'node:crypto';

/**
 * TTL-cached wrapper around the Real-Debrid client. Real-Debrid rate-limits
 * aggressively, so list/info/downloads responses are cached; instant
 * availability remembers when RD disabled the endpoint for this account.
 */
export class CachedRealDebrid implements RdGateway {
  get provider() { return this.rd.provider; }
  get allowUncached() { return this.rd.allowUncached; }
  readonly cacheKey: string;
  constructor(
    private rd: RdGateway,
    private caches: CacheSet,
  ) {
    this.cacheKey = rd.cacheKey ?? randomUUID();
  }

  private key(value: string): string {
    return `${this.cacheKey}:${value}`;
  }

  async getUser(): Promise<{ id: number | string; username: string }> {
    const key = this.key('user');
    const cached = this.caches.misc.get(key) as { id: number | string; username: string } | undefined;
    if (cached) return cached;
    const user = await this.rd.getUser();
    this.caches.misc.set(key, user);
    return user;
  }

  async listTorrents(): Promise<RdTorrentSummary[]> {
    const cached = this.caches.rdTorrents.get(this.key('all')) as RdTorrentSummary[] | undefined;
    if (cached) return cached;
    const list = await this.rd.listTorrents();
    this.caches.rdTorrents.set(this.key('all'), list);
    return list;
  }

  async getTorrentInfo(id: string): Promise<RdTorrent> {
    const key = this.key(`info:${id}`);
    const cached = this.caches.rdTorrentInfo.get(key) as RdTorrent | undefined;
    if (cached) return cached;
    const info = await this.rd.getTorrentInfo(id);
    if (info.status === 'downloaded') this.caches.rdTorrentInfo.set(key, info);
    return info;
  }

  async listDownloads(): Promise<RdDownload[]> {
    const cached = this.caches.rdDownloads.get(this.key('all')) as RdDownload[] | undefined;
    if (cached) return cached;
    const list = await this.rd.listDownloads();
    this.caches.rdDownloads.set(this.key('all'), list);
    return list;
  }

  async addMagnet(magnet: string, cachedOnly?: boolean): Promise<{ id: string; uri: string }> {
    // A freshly added magnet changes the torrent list.
    this.caches.rdTorrents.delete(this.key('all'));
    if (cachedOnly === undefined) return this.rd.addMagnet(magnet);
    if (cachedOnly || !this.allowUncached) return this.rd.addMagnet(magnet, cachedOnly);
    // Share an in-flight submission and briefly remember queued responses.
    const key = this.key(`queue:${magnet}`);
    const cached = this.caches.misc.get(key) as Promise<{ id: string; uri: string }> | undefined;
    if (cached) return cached;
    const pending = this.rd.addMagnet(magnet, false).catch(err => { this.caches.misc.delete(key); throw err; });
    this.caches.misc.set(key, pending);
    return pending;
  }

  async unrestrict(link: string): Promise<{ download: string; filename: string }> {
    const key = this.key(`unrestrict:${link}`);
    const cached = this.caches.misc.get(key) as { download: string; filename: string } | undefined;
    if (cached) return cached;
    const out = await this.rd.unrestrict(link);
    this.caches.misc.set(key, out);
    return out;
  }

  async deleteTorrent(torrentId: string): Promise<void> {
    this.caches.rdTorrents.delete(this.key('all'));
    this.caches.rdTorrentInfo.delete(this.key(`info:${torrentId}`));
    return this.rd.deleteTorrent(torrentId);
  }

  async selectAllFiles(torrentId: string): Promise<void> {
    this.caches.rdTorrentInfo.delete(this.key(`info:${torrentId}`));
    return this.rd.selectAllFiles(torrentId);
  }

  /**
   * Returns the set of hashes RD has cached, or `null` when availability cannot
   * be determined (endpoint disabled for this account).
   */
  async instantAvailability(hashes: string[]): Promise<Set<string> | null> {
    if (hashes.length === 0) return new Set<string>();
    if (this.caches.misc.get(this.key('iaDisabled'))) return null;

    try {
      const data = await this.rd.instantAvailability(hashes);
      if (data) {
        this.caches.instantAvailability.set(this.key(`batch:${hashes.slice(0, 20).join(',')}`), data);
      }
      return data;
    } catch (err) {
      if (err instanceof EndpointDisabledError) {
        // Remember so we never hammer the disabled endpoint again.
        this.caches.misc.set(this.key('iaDisabled'), true);
        console.warn('[rd] instantAvailability disabled for this account — search results shown ungated');
        return null;
      }
      throw err;
    }
  }
}
