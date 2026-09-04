import type { Config } from '../types.js';
import { RealDebridClient, type RdGateway } from './realdebrid.js';
import { TorBoxClient } from './torbox.js';

export function createDebridClient(credential: string, config: Config): RdGateway {
  if (credential.startsWith('torbox-download:')) {
    return new TorBoxClient(credential.slice('torbox-download:'.length), config.torboxApiBase ?? undefined, true);
  }
  return credential.startsWith('torbox:')
    ? new TorBoxClient(credential.slice('torbox:'.length), config.torboxApiBase ?? undefined)
    : new RealDebridClient(credential, config.rdApiBase ?? undefined);
}
