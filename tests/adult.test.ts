// Adult-content filter: index categories (TPB 5xx / Torznab 5xxx) and release
// studio markers are treated as adult; mainstream titles that merely share a
// name (or the action film "xXx") must NOT be caught.
import { describe, it, expect } from 'vitest';
import { isAdultRelease } from '../src/services/adult.js';
import type { TorrentResult } from '../src/types.js';

function r(overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    infoHash: 'a'.repeat(40), title: 'Obsession', isSeries: false,
    raw: 'Obsession.2017.1080p.mkv', source: 'piratebay', ...overrides,
  };
}

describe('isAdultRelease', () => {
  it('flags adult index categories (TPB 5xx and Torznab 5xxx)', () => {
    expect(isAdultRelease(r({ category: '507' }))).toBe(true);
    expect(isAdultRelease(r({ category: '531' }))).toBe(true);
    expect(isAdultRelease(r({ category: '5050' }))).toBe(true);
    expect(isAdultRelease(r({ category: '207' }))).toBe(false); // HD movies
    expect(isAdultRelease(r({ category: '205' }))).toBe(false); // TV shows
  });

  it('flags explicit category text and studio markers in release names', () => {
    expect(isAdultRelease(r({ category: 'xxx' }))).toBe(true);
    expect(isAdultRelease(r({ raw: 'Obsession.2017.Brazzers.1080p.mkv' }))).toBe(true);
    expect(isAdultRelease(r({ raw: 'obsession-hd-hustler-1080p' }))).toBe(true);
  });

  it('flags the real-world download rows reported for "Obsession"', () => {
    expect(isAdultRelease(r({ raw: 'BFTP18 26 07 04 Lisa H Black Becomes My New Obsession XXX 1080p' }))).toBe(true);
    expect(isAdultRelease(r({ raw: 'PlayboyPlus 26 06 26 Malaya Mikos Beautiful Obsession XXX 1080p' }))).toBe(true);
    expect(isAdultRelease(r({ raw: 'Ladyboy Obsession - Nadia - Shimmery Bareback Bliss For Blonde Slut 1080p' }))).toBe(true);
    expect(isAdultRelease(r({ raw: 'BFTP18 26 07 04 Lisa H Black Becomes My New Obsession XXX 480p ' }))).toBe(true);
  });

  it('keeps mainstream releases that share the word (incl. the film xXx)', () => {
    expect(isAdultRelease(r())).toBe(false);
    expect(isAdultRelease(r({ raw: 'xXx.Return.of.Xander.Cage.2017.1080p.mkv' }))).toBe(false);
    expect(isAdultRelease(r({ title: 'Obsession', raw: 'Obsession.2009.720p.mkv', category: '204' }))).toBe(false);
  });
});
