// Tests the explicit download-row builder: uncached releases become separate
// "click to download" rows (externalUrl -> Tube action route), deduped, capped,
// and filtered by the quality profile / negatives / already-in-cloud hashes.
import { describe, it, expect } from 'vitest';
import { buildDownloadRows, MAX_DOWNLOAD_ROWS } from '../src/stream/downloadRows.js';
import type { TorrentResult } from '../src/types.js';

function r(hash: string, overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    infoHash: hash, title: 'Movie', isSeries: false, raw: `Movie.2020.1080p.mkv`, source: 'zilean', ...overrides,
  };
}

const actionUrl = (hash: string) => `http://localhost:7000/tok/download?hash=${hash}`;

describe('buildDownloadRows', () => {
  it('builds one click-to-download row per release, pointing at the Tube action route', () => {
    const rows = buildDownloadRows(
      [
        r('a'.repeat(40), { quality: '1080p', sizeBytes: 2 * 1024 ** 3 }),
        r('b'.repeat(40), { quality: '720p', sizeBytes: 1 * 1024 ** 3 }),
      ],
      { actionUrl },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toMatch(/^Download ⬇ /);
    expect(rows[0].url).toBeUndefined(); // not playable — an action row
    expect(rows[0].externalUrl).toBe(`http://localhost:7000/tok/download?hash=${'a'.repeat(40)}`);
    expect(rows[0].description).toContain('Click to add this release');
  });

  it('dedupes releases with the same quality and size and caps the offer list', () => {
    const candidates = Array.from({ length: MAX_DOWNLOAD_ROWS + 4 }, (_, i) =>
      r(String(i).repeat(40), { quality: i % 2 ? '720p' : '1080p', sizeBytes: (i % 2 ? 1 : 2) * 1024 ** 3 }));
    // Two distinct (quality,size) keys, so even a huge list yields at most two rows.
    expect(buildDownloadRows(candidates, { actionUrl })).toHaveLength(2);
  });

  it('skips releases outside the profile, blocked, or already in the cloud', () => {
    const candidates = [
      r('a'.repeat(40), { quality: '2160p', sizeBytes: 10 * 1024 ** 3 }), // above max res
      r('b'.repeat(40), { quality: '1080p', sizeBytes: 10 * 1024 ** 3 }), // above size cap
      r('c'.repeat(40), { quality: '1080p', sizeBytes: 2 * 1024 ** 3 }), // blocked
      r('d'.repeat(40), { quality: '1080p', sizeBytes: 2 * 1024 ** 3 }), // already in cloud
      r('e'.repeat(40), { quality: '1080p', sizeBytes: 2 * 1024 ** 3 }), // offered
    ];
    const rows = buildDownloadRows(candidates, {
      actionUrl,
      maxResolution: '1080p',
      maxSizeBytes: 4 * 1024 ** 3,
      negatives: new Set(['c'.repeat(40)]),
      cloudHashes: new Set(['d'.repeat(40)]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalUrl).toContain('e'.repeat(40));
  });

  it('floats preferred-language releases to the top of the offers', () => {
    const rows = buildDownloadRows(
      [
        r('a'.repeat(40), { quality: '1080p', raw: 'Movie.2020.1080p.English.mkv' }),
        r('b'.repeat(40), { quality: '1080p', raw: 'Movie.2020.1080p.Hindi.mkv' }),
      ],
      { actionUrl, preferredLanguages: ['hindi'] },
    );
    expect(rows[0].description).toContain('Hindi');
  });
});
