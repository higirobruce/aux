import { All, Controller, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAuth } from './auth.js';

/**
 * Catch-all for /api/auth/*  →  better-auth's universal Fetch handler.
 *
 * better-auth ships a standards-based `Request → Response` handler. We adapt
 * Fastify's req/reply to/from the Fetch primitives. Throttling is skipped at
 * the controller level — better-auth handles its own brute-force protections
 * for the magic-link surface per the library docs.
 */
@SkipThrottle()
@Controller('api/auth')
export class AuthController {
  @All('*')
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const auth = getAuth();

    // Reconstruct the full URL from the Fastify request.
    const protocol = (req.headers['x-forwarded-proto'] as string) ?? 'http';
    const host = req.headers.host ?? `localhost:${process.env.PORT ?? 4000}`;
    const url = new URL(req.url, `${protocol}://${host}`);

    // Build a Fetch Request. Body is only present on non-GET/HEAD.
    const body =
      req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) headers.set(k, v.join(', '));
      else headers.set(k, String(v));
    }

    const fetchRequest = new Request(url.toString(), {
      method: req.method,
      headers,
      body,
    });

    const response = await auth.handler(fetchRequest);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      // Fastify uses appendHeader for repeated headers (e.g. Set-Cookie).
      reply.header(key, value);
    });

    const responseBody = await response.text();
    return reply.send(responseBody);
  }
}
