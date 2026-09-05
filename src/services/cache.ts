// In-memory TTL cache factory shared by the debrid wrapper and read-heavy
// services (TMDB, search) to avoid hammering external APIs.
/**
 * Minimal in-memory TTL cache. Single-process, single-instance is fine for a
 * self-hosted addon; avoids hammering the Real-Debrid / TMDB / Zilean APIs.
 */
export class TtlCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private ttlMs: number;
  private maxEntries: number;

  /**
   * @param ttlMs entry lifetime in milliseconds.
   * @param maxEntries eviction bound; when full, the oldest entry is dropped.
   */
  constructor(ttlMs: number, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Returns the value if present and unexpired (expired entries are removed).
   * A hit refreshes the entry to the back of the map — simple LRU-ish behavior.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh on access (simple LRU-ish behavior).
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /** Stores a value with a fresh expiry; evicts the oldest entry when at capacity. */
  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Removes one entry (used by mutations to invalidate stale data). */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Removes every entry. */
  clear(): void {
    this.store.clear();
  }
}

/** Named caches used across the app; each is independent (own TTL/eviction). */
export interface CacheSet {
  rdTorrents: TtlCache<unknown>;
  rdTorrentInfo: TtlCache<unknown>;
  rdDownloads: TtlCache<unknown>;
  instantAvailability: TtlCache<unknown>;
  tmdb: TtlCache<unknown>;
  search: TtlCache<unknown>;
  misc: TtlCache<unknown>;
}

/**
 * Builds one cache per concern, all seeded from the same base TTL. TMDB gets
 * 30x the base (metadata rarely changes); search keeps at least 60s to stay
 * snappy; the rest use the base TTL directly.
 */
export function createCaches(ttlSeconds: number): CacheSet {
  const ttlMs = ttlSeconds * 1000;
  return {
    rdTorrents: new TtlCache(ttlMs),
    rdTorrentInfo: new TtlCache(ttlMs),
    rdDownloads: new TtlCache(ttlMs),
    instantAvailability: new TtlCache(ttlMs),
    tmdb: new TtlCache(ttlMs * 30), // metadata rarely changes
    search: new TtlCache(Math.max(ttlMs, 60_000)), // keep search snappy
    misc: new TtlCache(ttlMs),
  };
}
