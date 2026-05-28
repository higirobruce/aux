import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { ZodExceptionFilter } from './common/zod-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true })
  );

  // Security headers per docs/implementation.html §18 are configured at the
  // edge (Vercel / Cloudflare). @fastify/helmet@13 requires Fastify 5; NestJS
  // 10's platform-fastify bundles Fastify 4. Wire it back when we upgrade to
  // NestJS 11 (which targets Fastify 5).

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3100',
    credentials: true,
  });

  // Global /api prefix so the Next.js proxy can rewrite /api/* → here cleanly.
  app.setGlobalPrefix('api');

  app.useGlobalFilters(new ZodExceptionFilter());

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`aux api listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start api:', err);
  process.exit(1);
});
