import { config } from 'dotenv';
config({ path: '../../.env' });
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh' },
});
