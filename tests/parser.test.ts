// Tests the best-effort release-name parser (parseFilename, guessType,
// isVideoFile, normalizeLanguage) used to label streams and catalog entries.
import { describe, it, expect } from 'vitest';
import { parseFilename, guessType, isVideoFile, normalizeLanguage } from '../src/meta/parser.js';

describe('parseFilename', () => {
  it('parses a movie release', () => {
    const p = parseFilename('The.Matrix.1999.1080p.BluRay.x265-GECKOS.mkv');
    expect(p.title).toBe('The Matrix');
    expect(p.year).toBe(1999);
    expect(p.isSeries).toBe(false);
    expect(p.quality).toBe('1080P');
    expect(p.group).toBe('GECKOS');
  });

  it('parses a series episode', () => {
    const p = parseFilename('Breaking.Bad.S01E05.720p.WEB-DL.x264-EXPLOIT.mkv');
    expect(p.title).toBe('Breaking Bad');
    expect(p.isSeries).toBe(true);
    expect(p.season).toBe(1);
    expect(p.episode).toBe(5);
    expect(p.quality).toBe('720P');
    expect(p.group).toBe('EXPLOIT');
  });

  it('parses a season pack (no episode)', () => {
    const p = parseFilename('The.Office.US.S03.COMPLETE.1080p.BluRay.x265.mkv');
    expect(p.isSeries).toBe(true);
    expect(p.season).toBe(3);
    expect(p.episode).toBeUndefined();
    expect(p.title).toContain('The Office');
  });

  it('handles underscores and lowercase', () => {
    const p = parseFilename('movie_2024_2160p_web.mkv');
    expect(p.title).toBe('movie');
    expect(p.year).toBe(2024);
    expect(p.quality).toBe('2160P');
  });

  it('detects 4K quality', () => {
    const p = parseFilename('Dune.Part.Two.2024.4K.HDR.DV.mkv');
    expect(p.quality).toBe('4K');
    expect(p.year).toBe(2024);
  });

  it('does not treat the dot in "5.1" audio as a file extension', () => {
    const p = parseFilename('The Boy in the Striped Pyjamas (2008) (1080p BluRay x265 HEVC 10bit AAC 5.1 RZeroX)');
    expect(p.title).toBe('The Boy in the Striped Pyjamas');
    expect(p.year).toBe(2008);
    expect(p.quality).toBe('1080P');
  });

  it('detects audio languages like Hindi and Dual', () => {
    const p = parseFilename('Movie.2024.1080p.Hindi.Dual.Audio.x264.mkv');
    expect(p.languages).toContain('Hindi');
    expect(p.languages).toContain('Dual');
  });

  it('reports no languages when none are tagged', () => {
    expect(parseFilename('Movie.2024.1080p.BluRay.x264.mkv').languages).toEqual([]);
  });

  it('detects a broad set of languages from release tags', () => {
    expect(parseFilename('Movie.2024.1080p.German.x264.mkv').languages).toContain('German');
    expect(parseFilename('Movie.2024.720p.FRENCH.x264.mkv').languages).toContain('French');
    expect(parseFilename('Movie.2024.1080p.URDU.x264.mkv').languages).toContain('Urdu');
    expect(parseFilename('Movie.2024.1080p.SPANISH.x264.mkv').languages).toContain('Spanish');
  });

  it('normalizes language aliases to a canonical key', () => {
    expect(normalizeLanguage('deutch')).toBe('german');
    expect(normalizeLanguage('deu')).toBe('german');
    expect(normalizeLanguage('German')).toBe('german');
    expect(normalizeLanguage('fra')).toBe('french');
  });

  it('strips scene/cam release tags like DCPRIP and LTE from movie titles', () => {
    const p = parseFilename('Toy.Story.5.2026.1080p.DCPRIP.LTE.x264-SPLiCE.mkv');
    expect(p.title).toBe('Toy Story 5');
    expect(p.year).toBe(2026);
    expect(p.quality).toBe('1080P');
    expect(p.group).toBe('SPLICE');
  });
});

describe('guessType', () => {
  it('classifies SxxExx as series', () => {
    expect(guessType('Show.S02E03.mkv')).toBe('series');
  });
  it('classifies plain titles as movie', () => {
    expect(guessType('Some.Movie.2024.mkv')).toBe('movie');
  });
});

describe('isVideoFile', () => {
  it('accepts video extensions', () => {
    expect(isVideoFile('movie.mkv')).toBe(true);
    expect(isVideoFile('movie.mp4')).toBe(true);
  });
  it('rejects subtitles', () => {
    expect(isVideoFile('movie.srt')).toBe(false);
  });
  it('rejects samples', () => {
    expect(isVideoFile('sample.mkv')).toBe(false);
  });
});
