import { config } from 'dotenv';
config({ path: new URL('../../../.env', import.meta.url) });
import { runMigrations } from './migrator.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

await runMigrations(url);
console.log('Migrations applied and system roles synced.');
