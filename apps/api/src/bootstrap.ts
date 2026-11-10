import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<INestApplication> {
  // rawBody: webhook signatures (WhatsApp) are computed over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { logger: opts.logger === false ? false : undefined, rawBody: true });
  // /mcp is the conventional MCP endpoint path, outside the versioned REST API.
  // Invoice uploads arrive base64-encoded in JSON (10 MB files ≈ 14 MB of text).
  app.useBodyParser('json', { limit: '20mb' });
  app.setGlobalPrefix('v1', { exclude: ['health', 'mcp'] });
  app.enableShutdownHooks();
  return app;
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const doc = new DocumentBuilder()
    .setTitle('Kitchain API')
    .setDescription('Restaurant back-of-house platform API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, doc));
}
