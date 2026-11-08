import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { syncSystemRoles } from './system-roles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Works from both src/ (tsx) and dist/ (built). */
export const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await syncSystemRoles(db);
  } finally {
    await pool.end();
  }
}
