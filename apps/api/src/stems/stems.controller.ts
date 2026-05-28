import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { StemsService } from './stems.service.js';

const SignSchema = z.object({
  sessionId: z.string().uuid(),
  filename: z.string().min(1).max(200),
  contentType: z
    .string()
    .min(1)
    .max(120)
    .regex(/^(audio|application)\//, 'must be audio/* or application/* mime'),
});

const RegisterSchema = z.object({
  name: z.string().min(1).max(200),
  s3Key: z.string().min(1).max(500),
  lengthMs: z.number().int().nonnegative(),
  channels: z.number().int().min(1).max(8),
  sampleRate: z.number().int().min(8_000).max(192_000),
  peakDb: z.number().min(-200).max(20),
  lufsI: z.number().min(-200).max(20),
});

const SwapSourceSchema = z.object({
  s3Key: z.string().min(1).max(500),
  lengthMs: z.number().int().nonnegative(),
  channels: z.number().int().min(1).max(8),
  sampleRate: z.number().int().min(8_000).max(192_000),
  peakDb: z.number().min(-200).max(20),
  lufsI: z.number().min(-200).max(20),
});

@UseGuards(AuthGuard)
@Controller()
export class StemsController {
  constructor(private readonly stems: StemsService) {}

  /** Mint a presigned PUT URL — body: { sessionId, filename, contentType }. */
  @Post('stems/sign')
  async sign(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = SignSchema.parse(body);
    return this.stems.signUpload({
      userId: req.user.id,
      sessionId: parsed.sessionId,
      filename: parsed.filename,
      contentType: parsed.contentType,
    });
  }

  /** List stems in a session, with short-lived signed download URLs. */
  @Get('sessions/:id/stems')
  async list(@Req() req: AuthenticatedRequest, @Param('id') sessionId: string) {
    return this.stems.listForSessionWithUrls(req.user.id, sessionId);
  }

  /** Register a stem after the client has uploaded to S3. */
  @Post('sessions/:id/stems')
  async register(
    @Req() req: AuthenticatedRequest,
    @Param('id') sessionId: string,
    @Body() body: unknown
  ) {
    const parsed = RegisterSchema.parse(body);
    return this.stems.register({
      userId: req.user.id,
      sessionId,
      ...parsed,
    });
  }

  /**
   * Swap the audio source of an existing stem in place. Replaces s3_key
   * + audio metadata; keeps id + name so every per-channel parameter
   * (volume / pan / EQ / comp) stays attached. The old S3 object is
   * best-effort deleted.
   */
  @Put('sessions/:id/stems/:stemId/swap-source')
  async swapSource(
    @Req() req: AuthenticatedRequest,
    @Param('id') sessionId: string,
    @Param('stemId') stemId: string,
    @Body() body: unknown
  ) {
    const parsed = SwapSourceSchema.parse(body);
    return this.stems.swapSource({
      userId: req.user.id,
      sessionId,
      stemId,
      ...parsed,
    });
  }

  /** Delete a stem (removes the row + the S3 object). */
  @Delete('sessions/:id/stems/:stemId')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') sessionId: string,
    @Param('stemId') stemId: string
  ) {
    await this.stems.delete(req.user.id, sessionId, stemId);
    return { ok: true };
  }
}
