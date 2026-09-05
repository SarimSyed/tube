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
 * Format: `[torbox: | torbox-download:]token[~lang1,lang2]`. A bare token
 * selects Real-Debrid; `torbox:` selects TorBox; `torbox-download:` selects
 * TorBox with `allowUncached` (it may queue uncached magnets). The `~lang`
 * suffix is stripped here — it is read separately by `preferredLanguages`.
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

/** Languages to float to the top of the stream list, parsed from `~lang1,lang2`. */
export function preferredLanguages(credential: string): string[] {
  const idx = credential.indexOf('~');
  if (idx < 0) return [];
  return credential.slice(idx + 1).split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
