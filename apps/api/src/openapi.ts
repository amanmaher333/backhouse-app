import { writeFileSync } from 'node:fs';
import { buildOpenApi, createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

// Writes openapi.json without starting the HTTP server.
const app = await createApp(loadConfig(), { logger: false });
await app.init();
writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(buildOpenApi(app), null, 2));
await app.close();
console.log('Wrote apps/api/openapi.json');
