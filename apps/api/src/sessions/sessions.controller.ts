import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { requireDevUser } from '../common/dev-user.js';
import { SessionsService } from './sessions.service.js';

const CreateSessionSchema = z.object({
  name: z.string().min(1).max(120),
  storageMode: z.enum(['cloud', 'local']),
});

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  async list() {
    // TODO: pull userId from auth context once better-auth lands.
    return this.sessions.list(requireDevUser());
  }

  @Post()
  async create(@Body() body: unknown) {
    const parsed = CreateSessionSchema.parse(body);
    return this.sessions.create({
      ownerId: requireDevUser(),
      name: parsed.name,
      storageMode: parsed.storageMode,
    });
  }
}
