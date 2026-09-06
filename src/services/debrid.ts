// Parses the install-URL credential to pick the right debrid client. The
// credential carries the provider API token, optionally prefixed with `torbox:`
// / `torbox-download:` (the latter enables uncached queueing) and optionally
// suffixed with `~lang1,lang2` for preferred stream languages.
import type { Config } from '../types.js';
import { RealDebridClient, type RdGateway } from './realdebrid.js';
import { TorBoxClient } from './torbox.js';

/**
 * Builds the debrid client for an install URL credential.
 *
 * Format: `[torbox: | torbox-download:]token[~prefs]`. A bare token
 * selects Real-Debrid; `torbox:` selects TorBox; `torbox-download:` selects
 * TorBox with `allowUncached` (it may queue uncached magnets). The `~prefs`
 * suffix is read separately by {@link parseCredentialPrefs}.
 */
export function createDebridClient(credential: string, config: Config): RdGateway {
  const base = credential.includes('~') ? credential.slice(0, credential.indexOf('~')) : credential;
  if (base.startsWith('torbox-download:')) {
    return new TorBoxClient(base.slice('torbox-download:'.length), config.torboxApiBase ?? undefined, true);
  }
  return base.startsWith('torbox:')
    ? new TorBoxClient(base.slice('torbox:'.length), config.torboxApiBase ?? undefined)
    : new RealDebridClient(base, config.rdApiBase ?? undefined);
}

/** Quality labels accepted in a per-install `maxres=` profile knob. */
const MAX_RES_KEYS = new Set(['2160p', '4k', '1440p', '1080p', '720p', '480p', '360p']);

/** Per-install preferences baked into the credential's `~prefs` suffix. */
export interface InstallPrefs {
  /** Languages floated to the top of the stream list. */
  languages: string[];
  /** Highest resolution to offer (e.g. "1080p"); undefined = unlimited. */
  maxResolution?: string;
  /** Largest file to offer in bytes; undefined = no size cap. */
  maxSizeBytes?: number;
}

/**
 * Parse the `~prefs` suffix of an install credential. The suffix is a
 * semicolon-separated list where the plain comma-separated section(s) carry
 * preferred languages (backward compatible with older installs) and `key=value`
 * sections carry per-install network profile knobs, e.g. `~hindi;maxres=1080p;maxgb=4`.
 * Unknown or malformed knobs are ignored so a bad suffix never breaks playback.
 */
export function parseCredentialPrefs(credential: string): InstallPrefs {
  const prefs: InstallPrefs = { languages: [] };
  const idx = credential.indexOf('~');
  if (idx < 0) return prefs;
  for (const raw of credential.slice(idx + 1).split(';')) {
    const section = raw.trim();
    if (!section) continue;
    const eq = section.indexOf('=');
    if (eq === -1) {
      for (const lang of section.split(',')) {
        const t = lang.trim().toLowerCase();
        if (t) prefs.languages.push(t);
      }
      continue;
    }
    const key = section.slice(0, eq).trim().toLowerCase();
    const value = section.slice(eq + 1).trim();
    if (key === 'maxres') {
      // Normalize "720P", "720", "4K" style values to a canonical label.
      const norm = value.toLowerCase().replace(/^(\d+)$/, '$1p');
      if (MAX_RES_KEYS.has(norm)) prefs.maxResolution = norm === '4k' ? '2160p' : norm;
    } else if (key === 'maxgb') {
      const gb = Number.parseFloat(value);
      if (Number.isFinite(gb) && gb > 0) prefs.maxSizeBytes = Math.round(gb * 1024 ** 3);
    }
  }
  return prefs;
}

/** Languages to float to the top of the stream list, parsed from the suffix. */
export function preferredLanguages(credential: string): string[] {
  return parseCredentialPrefs(credential).languages;
}
