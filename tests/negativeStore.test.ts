// Tests NegativeStore persistence against a JSON file in a temp directory,
// including reloading hashes in a fresh instance and starting empty when absent.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NegativeStore } from '../src/services/negativeStore.js';

describe('NegativeStore', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('persists hashes to disk and reloads them in a fresh instance', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tube-neg-'));
    const file = join(dir, 'probe-neg.json');

    const store = new NegativeStore(file);
    store.get().add('AAA'.repeat(10));
    store.get().add('bbb'.repeat(10));
    await store.save();

    const reloaded = new NegativeStore(file);
    expect(reloaded.get().has('aaa'.repeat(10))).toBe(true);
    expect(reloaded.get().has('bbb'.repeat(10))).toBe(true);
    expect(reloaded.get().size).toBe(2);
  });

  it('starts empty when no file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'tube-neg-'));
    const store = new NegativeStore(join(dir, 'missing.json'));
    expect(store.get().size).toBe(0);
  });
});
