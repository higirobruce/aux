import { getPrismaClient } from '@aux/db';
import { Injectable, NotFoundException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { StorageService } from '../storage/storage.service.js';

/** Stems stored client-side via OPFS carry this prefix on s3_key. The server
 *  treats such keys as opaque markers — no signing, no S3 calls. */
const OPFS_KEY_PREFIX = 'opfs:';
const isLocalKey = (k: string | null | undefined) => !!k && k.startsWith(OPFS_KEY_PREFIX);

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

export interface SwapSourceInput {
  userId: string;
  sessionId: string;
  stemId: string;
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

  /** Plain list — no signed URLs. */
  async listForSession(userId: string, sessionId: string) {
    await this.sessions.assertOwnership(userId, sessionId);
    return this.db.stem.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * List + a 1-hour signed download URL per stem, for browser playback.
   * Local-mode stems (s3Key prefixed `opfs:`) return downloadUrl: null —
   * the client reads them from OPFS and never goes through R2.
   */
  async listForSessionWithUrls(userId: string, sessionId: string) {
    await this.sessions.assertOwnership(userId, sessionId);
    const stems = await this.db.stem.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      stems.map(async (stem) => ({
        ...stem,
        downloadUrl:
          stem.s3Key && !isLocalKey(stem.s3Key)
            ? await this.storage.signGetUrl(stem.s3Key, 3600)
            : null,
      }))
    );
  }

  /**
   * Replace the underlying audio + metadata on an existing stem. Keeps
   * `id` and `name` — every MixState row (volume / pan / EQ / comp) stays
   * attached because they're keyed by stemId. The old S3 object is deleted
   * after the swap so we don't leak storage.
   */
  async swapSource(input: SwapSourceInput) {
    await this.sessions.assertOwnership(input.userId, input.sessionId);
    const stem = await this.db.stem.findFirst({
      where: { id: input.stemId, sessionId: input.sessionId },
    });
    if (!stem) throw new NotFoundException('Stem not found');

    const oldS3Key = stem.s3Key;
    const updated = await this.db.stem.update({
      where: { id: input.stemId },
      data: {
        s3Key: input.s3Key,
        lengthMs: input.lengthMs,
        channels: input.channels,
        sampleRate: input.sampleRate,
        peakDb: input.peakDb,
        lufsI: input.lufsI,
      },
    });

    if (oldS3Key && oldS3Key !== input.s3Key && !isLocalKey(oldS3Key)) {
      // Cloud only — for opfs:* keys the audio lives in the client's browser
      // and the client handles its own cleanup.
      this.storage.deleteObject(oldS3Key).catch(() => {});
    }
    return updated;
  }

  async delete(userId: string, sessionId: string, stemId: string) {
    await this.sessions.assertOwnership(userId, sessionId);
    const stem = await this.db.stem.findFirst({
      where: { id: stemId, sessionId },
    });
    if (!stem) throw new NotFoundException('Stem not found');
    if (stem.s3Key && !isLocalKey(stem.s3Key)) {
      // Cloud only — see swapSource for the local-mode rationale.
      await this.storage.deleteObject(stem.s3Key);
    }
    await this.db.stem.delete({ where: { id: stemId } });
  }
}
