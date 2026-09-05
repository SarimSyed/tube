// Tests the addon's self-defined ID codec (rd:/rd:dl:/rd:s:e and sr: hashes).
// Also checks the search-context suffix round-trips and rejects malformed ids.
import { describe, it, expect } from 'vitest';
import { torrentId, downloadId, episodeId, searchId, parseLibraryId, parseSearchId } from '../src/id.js';

describe('id codec', () => {
  it('encodes and decodes torrent ids', () => {
    const id = torrentId('ABC123');
    expect(id).toBe('rd:ABC123');
    expect(parseLibraryId(id)).toEqual({ kind: 'torrent', torrentId: 'ABC123' });
  });

  it('encodes and decodes download ids', () => {
    const id = downloadId('DL1');
    expect(parseLibraryId(id)).toEqual({ kind: 'download', downloadId: 'DL1' });
  });

  it('encodes and decodes episode ids', () => {
    const id = episodeId('ABC123', 2, 7);
    expect(parseLibraryId(id)).toEqual({ kind: 'episode', torrentId: 'ABC123', season: 2, episode: 7 });
  });

  it('encodes and decodes search ids', () => {
    const id = searchId('ABCDEF0123');
    expect(id).toBe('sr:abcdef0123');
    expect(parseSearchId(id)).toBe('abcdef0123');
  });

  it('returns null for unknown ids', () => {
    expect(parseLibraryId('tt1234')).toBeNull();
    expect(parseSearchId('rd:123')).toBeNull();
  });
});

it('round-trips search context without relying on an expiring cache', async () => {
  const { parseSearchContext } = await import('../src/id.js');
  const context = { infoHash: 'a'.repeat(40), title: 'Un été', year: 2020, isSeries: false, raw: '', source: 'zilean' as const };
  const id = searchId(context.infoHash, context);
  expect(parseSearchId(id)).toBe(context.infoHash);
  expect(parseSearchContext(id)).toMatchObject({ title: 'Un été', year: 2020, isSeries: false });
  expect(parseSearchContext('sr:aaaa:garbage')).toBeNull();
  expect(parseSearchContext('sr:aaaa:' + Buffer.from('{"title":4}').toString('base64url'))).toBeNull();
});
