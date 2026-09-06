// Tube entry point. Loads configuration, builds the Express app (composition
// root: `app.ts`; HTTP routes: `routes.ts`), and starts listening — but only
// when this file is the entry module, so tests can build apps without binding
// a port. On shutdown it flushes the persisted blocked-hash stores.
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createApp, createNegativeStores } from './app.js';

// Global safety net: surface otherwise-silent async failures so a bug is not
// invisible. Tokens live in the URL path / request, never in these messages.
function logUnexpected(kind: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`[process] ${kind}: ${err.name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`[process] ${kind}:`, err);
  }
}
process.on('unhandledRejection', (reason) => logUnexpected('unhandledRejection', reason));
process.on('uncaughtException', (err) => logUnexpected('uncaughtException', err));

const config = loadConfig();

// Built here so the entry point can flush them on graceful shutdown.
const { negativeStore, torboxNegatives } = createNegativeStores(config.dataDir);
const app = createApp(config, { negativeStore, torboxNegatives });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = app.listen(config.port, () => {
    console.log(`Tube addon listening on http://0.0.0.0:${config.port}`);
    console.log(`Open http://<host>:${config.port}/configure to set up Real-Debrid`);
  });

  // Flush pending blocked-hash writes before exiting (containers stop via
  // SIGTERM; the debounced saver would otherwise lose the last few seconds).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[process] ${signal}: flushing state and closing HTTP server…`);
    server.close();
    try {
      await Promise.all([negativeStore.save(), torboxNegatives.save()]);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
