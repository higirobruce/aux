import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getAuth } from './auth.js';

/**
 * Guard that resolves the better-auth session from the incoming cookie and
 * attaches it to the Fastify request as `req.session` + `req.user`.
 *
 * Use on any endpoint that needs an authenticated user. Returns 401 on miss.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = getAuth();

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) headers.set(k, v.join(', '));
      else headers.set(k, String(v));
    }

    const result = await auth.api.getSession({ headers });
    if (!result?.session || !result.user) {
      throw new UnauthorizedException('Not signed in');
    }

    // Attach for downstream handlers.
    // biome-ignore lint/suspicious/noExplicitAny: augmenting Fastify request at runtime
    (req as any).session = result.session;
    // biome-ignore lint/suspicious/noExplicitAny: augmenting Fastify request at runtime
    (req as any).user = result.user;

    return true;
  }
}

/** Narrow request type for handlers that pass through the guard. */
export interface AuthenticatedRequest extends FastifyRequest {
  user: { id: string; email: string };
  session: { id: string };
}
