import type { ParsedMedia } from '../types.js';

export function normalizeTitle(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;
const SUB_EXT = /\.(srt|ass|ssa|sub|vtt|idx)$/i;

/** Known noise tokens to strip from titles. */
const NOISE = new Set([
  '4320p', '2160p', '1440p', '1080p', '720p', '480p', '360p', '4k', '8k', 'uhd', 'hd', 'hdr', 'hdr10',
  'hdr10plus', 'dv', 'dovi', 'dolby', 'vision', 'bluray', 'blu-ray', 'web', 'web-dl',
  'webrip', 'webdl', 'dvdrip', 'bdrip', 'brrip', 'hdrip', 'hdtv', 'remux', 'x264',
  'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'vp9', 'aac', 'aac2', 'ac3', 'dts',
  'dts-hd', 'dtshd', 'truehd', 'atmos', 'eac3', 'dd', 'dd5', 'ddp', 'flac', 'opus',
  '10bit', '8bit', 'hdr10+', 'proper', 'repack', 'rerelease', 'extended', 'unrated',
  'remastered', 'directors', 'cut', 'imax', 'dual', 'multi', 'subbed', 'dubbed',
  'multi-audio', 'nfo', 'sample', 'trailer', 'complete',
  'dcprip', 'lte', 'cam', 'camrip', 'hdcam', 'hdts', 'telesync', 'ts', 'dvdscr',
  'screener', 'webcap', 'rarbg', 'yts', 'yify',
]);

/** Audio-language tags commonly found in release names. */
const LANGUAGE_DETECT: Array<[RegExp, string]> = [
  [/\b(?:english|eng)\b/i, 'English'],
  [/\b(?:french|fre|fra)\b/i, 'French'],
  [/\b(?:german|deutsch|deu|ger)\b/i, 'German'],
  [/\b(?:urdu|urd)\b/i, 'Urdu'],
  [/\b(?:hindi|hin)\b/i, 'Hindi'],
  [/\b(?:tamil|tam)\b/i, 'Tamil'],
  [/\b(?:telugu)\b/i, 'Telugu'],
  [/\b(?:malayalam)\b/i, 'Malayalam'],
  [/\b(?:kannada)\b/i, 'Kannada'],
  [/\b(?:bengali)\b/i, 'Bengali'],
  [/\b(?:punjabi|pun)\b/i, 'Punjabi'],
  [/\b(?:marathi)\b/i, 'Marathi'],
  [/\b(?:gujarati|guj)\b/i, 'Gujarati'],
  [/\b(?:spanish|spa)\b/i, 'Spanish'],
  [/\b(?:italian|ita)\b/i, 'Italian'],
  [/\b(?:portuguese|por)\b/i, 'Portuguese'],
  [/\b(?:russian|rus)\b/i, 'Russian'],
  [/\b(?:japanese|jpn)\b/i, 'Japanese'],
  [/\b(?:korean|kor)\b/i, 'Korean'],
  [/\b(?:chinese|zho|chi)\b/i, 'Chinese'],
  [/\b(?:arabic|ara)\b/i, 'Arabic'],
  [/\b(?:turkish|tur)\b/i, 'Turkish'],
  [/\b(?:polish|pol)\b/i, 'Polish'],
  [/\b(?:dutch|dut|ned)\b/i, 'Dutch'],
  [/\b(?:thai|tha)\b/i, 'Thai'],
  [/\b(?:vietnamese|vie)\b/i, 'Vietnamese'],
  [/\b(?:indonesian|ind)\b/i, 'Indonesian'],
  [/\b(?:filipino|fil|tagalog)\b/i, 'Filipino'],
  [/\bdual\b/i, 'Dual'],
  [/\bmulti\b/i, 'Multi'],
];

const LANGUAGE_ALIASES: Record<string, string> = {
  english: 'english', eng: 'english', en: 'english',
  french: 'french', fre: 'french', fra: 'french', fr: 'french',
  german: 'german', deutsch: 'german', deutch: 'german', deu: 'german', ger: 'german', de: 'german',
  urdu: 'urdu', urd: 'urdu',
  hindi: 'hindi', hin: 'hindi',
  tamil: 'tamil', tam: 'tamil',
  telugu: 'telugu', tel: 'telugu',
  malayalam: 'malayalam', mal: 'malayalam',
  kannada: 'kannada', kan: 'kannada',
  bengali: 'bengali', ben: 'bengali',
  punjabi: 'punjabi', pun: 'punjabi', pan: 'punjabi',
  marathi: 'marathi', mar: 'marathi',
  gujarati: 'gujarati', guj: 'gujarati',
  spanish: 'spanish', spa: 'spanish', es: 'spanish',
  italian: 'italian', ita: 'italian', it: 'italian',
  portuguese: 'portuguese', por: 'portuguese', pt: 'portuguese',
  russian: 'russian', rus: 'russian', ru: 'russian',
  japanese: 'japanese', jpn: 'japanese', jp: 'japanese',
  korean: 'korean', kor: 'korean',
  chinese: 'chinese', chi: 'chinese', zho: 'chinese', zh: 'chinese',
  arabic: 'arabic', ara: 'arabic',
  turkish: 'turkish', tur: 'turkish',
  polish: 'polish', pol: 'polish',
  dutch: 'dutch', dut: 'dutch', ned: 'dutch', nl: 'dutch',
  thai: 'thai', tha: 'thai',
  vietnamese: 'vietnamese', vie: 'vietnamese',
  indonesian: 'indonesian', ind: 'indonesian',
  filipino: 'filipino', fil: 'filipino', tagalog: 'filipino',
  dual: 'dual', multi: 'multi',
};

/** Normalize a language name/code (e.g. "deutch"/"deu"/"german") to a canonical key. */
export function normalizeLanguage(input: string): string {
  return LANGUAGE_ALIASES[input.trim().toLowerCase()] ?? input.trim().toLowerCase();
}

const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;
const SEASON_EPISODE_RE = /[sS](\d{1,2})[eE](\d{1,3})/;
const SEASON_ONLY_RE = /[sS](\d{1,2})\b/;
const SEASON_WORD_RE = /season[.\s]*(\d{1,2})/i;
const EPISODE_ONLY_RE = /[eE](\d{1,3})\b/;
const QUALITY_RE = /\b(4320p|2160p|1440p|1080p|720p|480p|360p|4k|8k)\b/i;

function stripExtension(name: string): string {
  // Only strip a real file extension (terminal 1-5 alnum chars). A plain
  // `.[^.]+$` would truncate names like "...AAC 5.1 RZeroX)" at the dot in "5.1".
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

function humanize(name: string): string {
  return name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function removeBracketed(s: string): string {
  return s.replace(/[[({][^\])}]*[\])}]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isVideoFile(path: string): boolean {
  return VIDEO_EXT.test(path) && !SUB_EXT.test(path) && !/sample/i.test(path);
}

export function guessType(filename: string): 'movie' | 'series' {
  return SEASON_EPISODE_RE.test(filename) ||
    SEASON_WORD_RE.test(filename) ||
    SEASON_ONLY_RE.test(filename)
    ? 'series'
    : 'movie';
}

/**
 * Parse a release filename into structured media info. Best-effort and
 * tolerant of the wide variety of release naming conventions.
 */
export function parseFilename(filename: string): ParsedMedia {
  const raw = filename;
  const languages: string[] = [];
  for (const [re, label] of LANGUAGE_DETECT) {
    if (re.test(raw) && !languages.includes(label)) languages.push(label);
  }
  let working = humanize(stripExtension(filename));

  // Year
  const yearMatch = working.match(YEAR_RE);
  const year = yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined;
  if (yearMatch) working = working.replace(YEAR_RE, ' ');

  // Quality
  const qualityMatch = working.match(QUALITY_RE);
  const quality = qualityMatch ? qualityMatch[0].toUpperCase() : undefined;
  // Season / episode
  let season: number | undefined;
  let episode: number | undefined;
  let isSeries = false;
  // For series, the real title is everything BEFORE the season/episode marker —
  // episode names ("... - S01E06 - Episode Title - ...") otherwise pollute it.
  let seriesTitle: string | undefined;

  const se = working.match(SEASON_EPISODE_RE);
  if (se) {
    isSeries = true;
    season = Number.parseInt(se[1], 10);
    episode = Number.parseInt(se[2], 10);
    seriesTitle = working.slice(0, se.index).trim();
    working = working.replace(SEASON_EPISODE_RE, ' ');
  } else {
    const sw = working.match(SEASON_WORD_RE);
    if (sw) {
      isSeries = true;
      season = Number.parseInt(sw[1], 10);
      seriesTitle = working.slice(0, sw.index).trim();
      working = working.replace(SEASON_WORD_RE, ' ');
    } else {
      const so = working.match(SEASON_ONLY_RE);
      if (so) {
        isSeries = true;
        season = Number.parseInt(so[1], 10);
        seriesTitle = working.slice(0, so.index).trim();
        working = working.replace(SEASON_ONLY_RE, ' ');
      }
    }
    const ep = working.match(EPISODE_ONLY_RE);
    if (ep && isSeries) {
      episode = Number.parseInt(ep[1], 10);
      working = working.replace(EPISODE_ONLY_RE, ' ');
    }
  }
  // Release group: the token after the last hyphen, e.g. "x265-GECKOS".
  let group: string | undefined;
  const hyphenIdx = working.lastIndexOf('-');
  if (hyphenIdx >= 0) {
    const candidate = working.slice(hyphenIdx + 1).trim();
    if (candidate.length >= 2) {
      group = candidate.toUpperCase();
      working = working.slice(0, hyphenIdx).trim();
    }
  }
  // Remove bracketed noise and known tokens.
  working = removeBracketed(working);
  const tokens = working.split(/\s+/).filter((t) => {
    const key = t.toLowerCase().replace(/[^a-z0-9+]/g, '');
    return key.length > 0 && !NOISE.has(key);
  });
  working = tokens.join(' ').trim();

  let title = working.length > 0 ? working : humanize(stripExtension(filename));

  if (isSeries && seriesTitle) {
    // Trim trailing separators/whitespace, then strip any leftover bracketed bits.
    const cleaned = removeBracketed(seriesTitle.replace(/[\s._-]+$/, ''));
    if (cleaned) title = cleaned;
  }

  return { title, year, isSeries, season, episode, quality, group, languages, raw };
}
