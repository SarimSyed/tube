// Disk-backed store of torrent hashes the debrid provider blocked as infringing.
// It lives in the configured data dir and is loaded lazily, then re-saved
// (debounced) as new blocked hashes are discovered during stream resolution.
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistent set of torrent hashes explicitly blocked by RD. Temporary errors
 * and uncached files must not be stored here — only genuine "infringing file"
 * rejections, so the addon stops re-adding content RD will always refuse.
 */
export class NegativeStore {
  private set = new Set<string>();
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;

  /** @param file absolute path (in the data dir) of the backing JSON file. */
  constructor(private file: string) {}

  /**
   * Lazily reads the JSON array of hashes from disk (lowercasing each) on first
   * use. Missing or corrupt files are treated as an empty store.
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        for (const h of raw) if (typeof h === 'string') this.set.add(h.toLowerCase());
      }
    } catch {
      // Corrupt/unreadable file — start fresh.
    }
  }

  /** The live set (mutating it marks the store dirty; call saveSoon/save to persist). */
  get(): Set<string> {
    this.load();
    return this.set;
  }

  /**
   * Debounced persist (5s) so bursty stream resolution triggers a single write;
   * `unref` lets the process exit without waiting for the timer.
   */
  saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 5_000);
    this.saveTimer.unref?.();
  }

  /** Writes the sorted hash list atomically (tmp file + rename) to avoid a torn file. */
  async save(): Promise<void> {
    this.load();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.set].sort()));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[negative-store] could not persist:', err instanceof Error ? err.message : err);
    }
  }
}
