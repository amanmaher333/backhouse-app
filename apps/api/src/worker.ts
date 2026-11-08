import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { AgentRuntime } from './agents/runtime.js';

/**
 * Agent worker: polls for agents with unprocessed events (and daily scans) and runs them.
 * Postgres is the queue (per-agent advisory locks), so several workers can run safely.
 */
const config = loadConfig();
const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn', 'log'] });
const runtime = app.get(AgentRuntime);
const logger = new Logger('Worker');
let stopping = false;
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

logger.log(`Agent worker started (poll every ${config.WORKER_POLL_MS} ms)`);
while (!stopping) {
  try {
    const results = await runtime.runDue();
    for (const r of results.filter((x) => x.status !== 'skipped')) {
      logger.log(
        `run ${r.runId}: ${r.status}, events ${r.eventsProcessed}, tasks +${r.tasksCreated}/~${r.tasksUpdated}, auto ${r.actionsExecuted}, $${r.costUsd.toFixed(4)}`,
      );
    }
  } catch (err) {
    logger.error((err as Error).message);
  }
  await new Promise((res) => setTimeout(res, config.WORKER_POLL_MS));
}
await app.close();
