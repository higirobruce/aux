import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true })
  );

  // Security headers per docs/implementation.html §18.
  await app.register(helmet, {
    contentSecurityPolicy: false, // configured at the edge (Vercel / Cloudflare)
  });

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`aux api listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start api:', err);
  process.exit(1);
});
