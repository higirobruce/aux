import { getPrismaClient } from '@aux/db';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { StorageService } from '../storage/storage.service.js';

export interface SignUploadInput {
  userId: string;
  sessionId: string;
  filename: string;
  contentType: string;
}

export interface RegisterStemInput {
  userId: string;
  sessionId: string;
  name: string;
  s3Key: string;
  lengthMs: number;
  channels: number;
  sampleRate: number;
  peakDb: number;
  lufsI: number;
}

@Injectable()
export class StemsService {
  private readonly db = getPrismaClient();

  constructor(
    private readonly storage: StorageService,
    private readonly sessions: SessionsService
  ) {}

  async signUpload(input: SignUploadInput) {
    await this.sessions.assertOwnership(input.userId, input.sessionId);
    const stemId = crypto.randomUUID();
    const key = this.storage.stemKey(input.sessionId, stemId, input.filename);
    const uploadUrl = await this.storage.signPutUrl(key, input.contentType);
    return { stemId, key, uploadUrl };
  }

  async register(input: RegisterStemInput) {
    await this.sessions.assertOwnership(input.userId, input.sessionId);
    return this.db.stem.create({
      data: {
        sessionId: input.sessionId,
        name: input.name,
        s3Key: input.s3Key,
        lengthMs: input.lengthMs,
        channels: input.channels,
        sampleRate: input.sampleRate,
        peakDb: input.peakDb,
        lufsI: input.lufsI,
      },
    });
  }

  async listForSession(userId: string, sessionId: string) {
    await this.sessions.assertOwnership(userId, sessionId);
    return this.db.stem.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async delete(userId: string, sessionId: string, stemId: string) {
    await this.sessions.assertOwnership(userId, sessionId);
    const stem = await this.db.stem.findFirst({
      where: { id: stemId, sessionId },
    });
    if (!stem) throw new NotFoundException('Stem not found');
    if (stem.s3Key) {
      await this.storage.deleteObject(stem.s3Key);
    }
    await this.db.stem.delete({ where: { id: stemId } });
  }
}
