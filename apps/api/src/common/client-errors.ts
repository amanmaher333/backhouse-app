import { Body, Controller, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Public, type AccessTokenClaims, type AuthedRequest } from './auth.js';
import { reportClientError } from './monitoring.js';

const ClientErrorSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  stack: z.string().max(8000).optional(),
  path: z.string().max(300).optional(),
  kind: z.enum(['error', 'unhandledrejection', 'render']).default('error'),
  digest: z.string().max(100).optional(),
  userAgent: z.string().max(300).optional(),
  release: z.string().max(100).optional(),
});
class ClientErrorDto extends createZodDto(ClientErrorSchema) {}

/**
 * Fixed-window limits per sender and overall, so a broken page in a loop can't flood Sentry.
 * The sender is the signed-in user, else the IP (behind the web app's proxy that is the web server).
 */
const PER_SENDER = 20;
const OVERALL = 120;
const WINDOW_MS = 60_000;
let windowStart = 0;
let overall = 0;
const perSender = new Map<string, number>();

function allow(sender: string, now = Date.now()): boolean {
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    overall = 0;
    perSender.clear();
  }
  const n = perSender.get(sender) ?? 0;
  if (n >= PER_SENDER || overall >= OVERALL) return false;
  perSender.set(sender, n + 1);
  overall++;
  return true;
}

/** Browser errors from the web app, forwarded to Sentry (a no-op while Sentry is off). */
@ApiTags('monitoring')
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly jwt: JwtService) {}

  @Public()
  @Post()
  @HttpCode(204)
  async report(@Body() dto: ClientErrorDto, @Req() req: AuthedRequest): Promise<void> {
    // Errors can happen signed out (login page), so the token is optional and only used for ids.
    let ids: { userId?: string; orgId?: string | null } = {};
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ey')) {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7)).catch(() => null);
      if (claims) ids = { userId: claims.sub, orgId: claims.org };
    }
    if (!allow(ids.userId ?? req.ip ?? 'unknown')) throw new HttpException('Too many error reports', 429);
    reportClientError(dto, ids);
  }
}
