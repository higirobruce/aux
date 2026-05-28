import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
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
    // TODO: pull user_id from auth context.
    return this.sessions.list('placeholder-user-id');
  }

  @Post()
  async create(@Body() body: unknown) {
    const parsed = CreateSessionSchema.parse(body);
    return this.sessions.create({
      ownerId: 'placeholder-user-id',
      name: parsed.name,
      storageMode: parsed.storageMode,
    });
  }
}
