import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { AgentRuntime } from './agents/runtime.js';
import { ChannelsService } from './channels/channels.service.js';
import { DigestService } from './channels/digest.js';
import { BillingService } from './billing/billing.service.js';
import { VerificationService } from './verification/verification.js';
import { ZatcaService } from './zatca/zatca.service.js';
import { FoodicsService } from './integrations/foodics/foodics.service.js';
import { MonthlySavingsService } from './modules/savings-monthly.js';
import { flushMonitoring, initMonitoring, reportError } from './common/monitoring.js';

/**
 * Agent worker: polls for agents with unprocessed events (and daily scans) and runs them.
 * Postgres is the queue (per-agent advisory locks), so several workers can run safely.
 */
const config = loadConfig();
initMonitoring(config, 'worker');
const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn', 'log'] });
const runtime = app.get(AgentRuntime);
const channels = app.get(ChannelsService);
const digests = app.get(DigestService);
const billing = app.get(BillingService);
const verification = app.get(VerificationService);
const zatca = app.get(ZatcaService);
const foodics = app.get(FoodicsService);
const monthlySavings = app.get(MonthlySavingsService);
const logger = new Logger('Worker');
let stopping = false;
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

logger.log(`Agent and messaging worker started (poll every ${config.WORKER_POLL_MS} ms)`);
while (!stopping) {
  try {
    const results = await runtime.runDue();
    for (const r of results.filter((x) => x.status !== 'skipped')) {
      logger.log(
        `run ${r.runId}: ${r.status}, events ${r.eventsProcessed}, tasks +${r.tasksCreated}/~${r.tasksUpdated}, auto ${r.actionsExecuted}, $${r.costUsd.toFixed(4)}`,
      );
    }
    // Billing: end trials, renew, retry failed payments.
    const b = await billing.runDue();
    if (b.trialsEnded || b.renewed || b.failed) logger.log(`billing: ${b.trialsEnded} trials ended, ${b.renewed} paid, ${b.failed} failed`);
    // Company checks that could not reach the register.
    await verification.retryPending();
    // ZATCA: send signed invoices that couldn't be cleared or reported yet.
    const z = await zatca.submitDue();
    if (Object.keys(z).length) logger.log(`zatca (${zatca.mode}): ${JSON.stringify(z)}`);
    // Foodics: webhooks, catalogue refresh, sales import, purchases recorded in Foodics.
    const f = await foodics.runDue();
    if (f.catalogs || f.orders || f.pushed) logger.log(`foodics (${foodics.mode}): ${f.catalogs} catalogues, ${f.orders} orders, ${f.pushed} purchases recorded`);
    // WhatsApp: approval cards for new tasks, then anything queued (retries included).
    const cards = await channels.notifyPending();
    const daily = await digests.runDue();
    const monthly = await monthlySavings.runDue();
    const sent = await channels.deliver();
    if (cards || daily || monthly || sent) logger.log(`whatsapp (${channels.mode}): ${cards} cards, ${daily} digests and ${monthly} savings reports queued, ${sent} messages sent`);
  } catch (err) {
    logger.error((err as Error).message);
    reportError(err, { source: 'worker' });
  }
  await new Promise((res) => setTimeout(res, config.WORKER_POLL_MS));
}
await app.close();
await flushMonitoring();
