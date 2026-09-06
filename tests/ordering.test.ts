// Tests the shared result-ordering comparator used by the tt path and the
// TorBox cache-probe path. A single deterministic hierarchy: quality, then
// seeders, then size, then preferred-language. Pure function — no HTTP.
import { describe, it, expect } from 'vitest';
import { compareStreamCandidates, passesQualityFilters } from '../src/stream/cacheProbe.js';
import type { TorrentResult } from '../src/types.js';

function r(overrides: Partial<TorrentResult> = {}): TorrentResult {
  return { infoHash: 'h'.repeat(40), title: 't', isSeries: false, raw: 't', source: 'zilean', ...overrides };
}

describe('compareStreamCandidates', () => {
  it('ranks higher quality above lower regardless of seeder count', () => {
    const hi = r({ quality: '2160p', seeders: 1 });
    const lo = r({ quality: '720p', seeders: 5000 });
    expect(compareStreamCandidates(hi, lo)).toBeLessThan(0);
    expect(compareStreamCandidates(lo, hi)).toBeGreaterThan(0);
  });

  it('breaks a quality tie by seeders', () => {
    const many = r({ quality: '1080p', seeders: 300 });
    const few = r({ quality: '1080p', seeders: 5 });
    expect(compareStreamCandidates(many, few)).toBeLessThan(0);
  });

  it('breaks a quality+seeder tie by size', () => {
    const big = r({ quality: '1080p', seeders: 5, sizeBytes: 10_000_000_000 });
    const small = r({ quality: '1080p', seeders: 5, sizeBytes: 1_000_000_000 });
    expect(compareStreamCandidates(big, small)).toBeLessThan(0);
  });

  it('floats a preferred-language match above an equal-quality non-match', () => {
    const pref = r({ quality: '1080p', raw: 'Movie.2020.1080p.Hindi.mkv' });
    const other = r({ quality: '1080p', raw: 'Movie.2020.1080p.English.mkv' });
    expect(compareStreamCandidates(pref, other, ['hindi'])).toBeLessThan(0);
    expect(compareStreamCandidates(other, pref, ['hindi'])).toBeGreaterThan(0);
  });

  it('sorts a known quality above an unknown one', () => {
    const known = r({ quality: '1080p' });
    const unknown = r({});
    expect(compareStreamCandidates(known, unknown)).toBeLessThan(0);
  });
});

describe('passesQualityFilters', () => {
  it('drops a known resolution below the minimum', () => {
    expect(passesQualityFilters(r({ quality: '720p' }), '1080p')).toBe(false);
    expect(passesQualityFilters(r({ quality: '1080p' }), '1080p')).toBe(true);
    expect(passesQualityFilters(r({ quality: '2160p' }), '1080p')).toBe(true);
  });

  it('keeps an unknown resolution when a minimum is set', () => {
    expect(passesQualityFilters(r({}), '1080p')).toBe(true);
  });

  it('excludes a listed source/quality token from the raw filename', () => {
    expect(passesQualityFilters(r({ raw: 'Movie.2020.1080p.HDCAM.mkv' }), undefined, ['hdcam'])).toBe(false);
    expect(passesQualityFilters(r({ raw: 'Movie.2020.1080p.WEB-DL.mkv' }), undefined, ['hdcam'])).toBe(true);
  });

  it('passes everything when no filters are configured', () => {
    expect(passesQualityFilters(r({ quality: '720p' }))).toBe(true);
  });

  it('drops a known resolution above the per-install maximum', () => {
    expect(passesQualityFilters(r({ quality: '2160p' }), undefined, undefined, '1080p')).toBe(false);
    expect(passesQualityFilters(r({ quality: '1080p' }), undefined, undefined, '1080p')).toBe(true);
    expect(passesQualityFilters(r({}), undefined, undefined, '1080p')).toBe(true); // unknown kept
  });

  it('drops a file larger than the per-install size cap and keeps unknown sizes', () => {
    const cap = 4 * 1024 ** 3;
    expect(passesQualityFilters(r({ quality: '2160p', sizeBytes: 6 * 1024 ** 3 }), undefined, undefined, undefined, cap)).toBe(false);
    expect(passesQualityFilters(r({ quality: '2160p', sizeBytes: 2 * 1024 ** 3 }), undefined, undefined, undefined, cap)).toBe(true);
    expect(passesQualityFilters(r({}), undefined, undefined, undefined, cap)).toBe(true); // unknown kept
  });
});
