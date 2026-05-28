import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      // Per docs/implementation.html §18 — rate limits per endpoint class.
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),
    AuthModule,
    HealthModule,
    SessionsModule,
  ],
})
export class AppModule {}
