import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { type AuthenticatedRequest, AuthGuard } from '../auth/auth.guard.js';
import { SessionsService } from './sessions.service.js';

const CreateSessionSchema = z.object({
  name: z.string().min(1).max(120),
  storageMode: z.enum(['cloud', 'local']),
});

@UseGuards(AuthGuard)
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    return this.sessions.list(req.user.id);
  }

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = CreateSessionSchema.parse(body);
    return this.sessions.create({
      ownerId: req.user.id,
      name: parsed.name,
      storageMode: parsed.storageMode,
    });
  }
}
