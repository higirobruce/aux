import { getPrismaClient } from '@aux/db';
import { type MixState, MixStateSchema } from '@aux/session-doc';
import { Injectable, NotFoundException } from '@nestjs/common';

/**
 * Session metadata service. Talks to Postgres via Prisma.
 */
@Injectable()
export class SessionsService {
  private readonly db = getPrismaClient();

  async list(userId: string) {
    return this.db.session.findMany({
      where: { ownerId: userId, archivedAt: null },
      orderBy: [{ lastOpenedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        storageMode: true,
        lastOpenedAt: true,
        createdAt: true,
      },
    });
  }

  async getById(userId: string, sessionId: string) {
    const session = await this.db.session.findFirst({
      where: { id: sessionId, ownerId: userId, archivedAt: null },
      include: {
        stems: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  /**
   * Persist the live mixer state (per-channel volume/pan/mute/solo).
   * The payload is validated against [[MixStateSchema]] before write.
   * Returns the validated value (with unknown channels stripped).
   */
  async saveMixState(userId: string, sessionId: string, payload: unknown): Promise<MixState> {
    await this.assertOwnership(userId, sessionId);
    const parsed = MixStateSchema.parse(payload);
    await this.db.session.update({
      where: { id: sessionId },
      data: { mixState: parsed },
    });
    return parsed;
  }

  async create(input: { ownerId: string; name: string; storageMode: 'cloud' | 'local' }) {
    return this.db.session.create({
      data: {
        ownerId: input.ownerId,
        name: input.name,
        storageMode: input.storageMode,
        lastOpenedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        storageMode: true,
        createdAt: true,
        lastOpenedAt: true,
      },
    });
  }

  async touch(userId: string, sessionId: string) {
    await this.db.session.updateMany({
      where: { id: sessionId, ownerId: userId },
      data: { lastOpenedAt: new Date() },
    });
  }

  async assertOwnership(userId: string, sessionId: string): Promise<void> {
    const exists = await this.db.session.findFirst({
      where: { id: sessionId, ownerId: userId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Session not found');
  }
}
