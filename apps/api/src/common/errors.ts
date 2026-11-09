import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import type { AuthedRequest } from './auth.js';
import { reportError } from './monitoring.js';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

function findPgError(err: unknown): PgError | undefined {
  let cur: any = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code)) return cur;
    cur = cur.cause;
  }
  return undefined;
}

/** Maps domain and Postgres errors to consistent JSON HTTP errors. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (err instanceof ZodValidationException) {
      const zodError = err.getZodError() as { issues: unknown[] };
      res.status(400).json({ statusCode: 400, error: 'ValidationError', issues: zodError.issues });
      return;
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      res.status(err.getStatus()).json(typeof body === 'string' ? { statusCode: err.getStatus(), message: body } : body);
      return;
    }
    // Compare by name: the domain package may be loaded more than once (tests, bundlers).
    if (err instanceof Error && err.name === 'UnitError') {
      res.status(422).json({ statusCode: 422, error: 'UnitError', message: err.message });
      return;
    }
    if (err instanceof Error && err.name === 'CsvError') {
      res.status(400).json({ statusCode: 400, error: 'CsvError', message: err.message });
      return;
    }
    const pg = findPgError(err);
    if (pg?.code === '23505') {
      res.status(409).json({ statusCode: 409, error: 'Conflict', message: 'Already exists', constraint: pg.constraint });
      return;
    }
    if (pg?.code === '23503') {
      res.status(422).json({ statusCode: 422, error: 'InvalidReference', message: 'Referenced record not found', constraint: pg.constraint });
      return;
    }
    if (pg?.code === '42501') {
      res.status(403).json({ statusCode: 403, error: 'Forbidden', message: 'Not allowed' });
      return;
    }
    if (pg?.code === '22P02') {
      res.status(400).json({ statusCode: 400, error: 'BadRequest', message: 'Invalid identifier' });
      return;
    }
    this.logger.error(err instanceof Error ? err.stack : String(err));
    // Only unexpected errors reach Sentry; the mapped ones above are answers, not faults.
    const req = host.switchToHttp().getRequest<AuthedRequest | undefined>();
    reportError(err, {
      source: 'http',
      method: req?.method,
      route: req?.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : req?.path,
      requestId: req?.requestId,
      userId: req?.auth?.userId,
      orgId: req?.auth?.orgId,
    });
    res.status(500).json({ statusCode: 500, error: 'InternalServerError', message: 'Unexpected error' });
  }
}
