/** Shared TypeScript types mirroring the API responses. */

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface AuthSession {
  session: { id: string; userId: string };
  user: AuthUser;
}

export interface SessionSummary {
  id: string;
  name: string;
  storageMode: 'cloud' | 'local';
  lastOpenedAt: string | null;
  createdAt: string;
}

export interface Stem {
  id: string;
  sessionId: string;
  name: string;
  s3Key: string | null;
  lengthMs: number;
  channels: number;
  sampleRate: number;
  peakDb: number;
  lufsI: number;
  createdAt: string;
}

export interface StemWithUrl extends Stem {
  downloadUrl: string | null;
}

export interface SessionDetail extends SessionSummary {
  stems: Stem[];
  mixState: unknown; // validated client-side via @aux/session-doc MixStateSchema
}
