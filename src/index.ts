// Tube entry point. Loads configuration, builds the Express app (composition
// root: `app.ts`; HTTP routes: `routes.ts`), and starts listening — but only
// when this file is the entry module, so tests can build apps without binding
// a port.
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

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
const app = createApp(config);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(config.port, () => {
    console.log(`Tube addon listening on http://0.0.0.0:${config.port}`);
    console.log(`Open http://<host>:${config.port}/configure to set up Real-Debrid`);
  });
}
