import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistent set of torrent hashes explicitly blocked by RD. Temporary errors
 * and uncached files must not be stored here.
 */
export class NegativeStore {
  private set = new Set<string>();
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string) {}

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

  saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 5_000);
    this.saveTimer.unref?.();
  }

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
