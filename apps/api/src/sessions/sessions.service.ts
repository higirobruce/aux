import { Injectable } from '@nestjs/common';

/**
 * Session metadata service.
 * v0.1 stub — Prisma client wiring lives in @aux/db (see docs/implementation.html §03).
 */
@Injectable()
export class SessionsService {
  async list(_userId: string) {
    return [];
  }

  async create(input: { ownerId: string; name: string; storageMode: 'cloud' | 'local' }) {
    // TODO: persist via @aux/db once Prisma client is initialized.
    return {
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      name: input.name,
      storageMode: input.storageMode,
      createdAt: new Date().toISOString(),
    };
  }
}
