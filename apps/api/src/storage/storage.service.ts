import { S3Client } from '@aws-sdk/client-s3';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/**
 * S3-compatible object storage.
 *
 * Dev: MinIO via docker-compose (R2_ENDPOINT=http://localhost:9000).
 * Prod: Cloudflare R2 (or AWS S3) — same client, different endpoint.
 *
 * Per docs/implementation.html §16.06 — stems upload direct browser → R2
 * via presigned URLs. The server never proxies audio.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private client!: S3Client;

  readonly bucket: string;

  constructor() {
    this.bucket = process.env.R2_BUCKET ?? 'aux-stems-dev';
  }

  onModuleInit() {
    const endpoint = process.env.R2_ENDPOINT ?? 'http://localhost:9000';
    const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? 'aux';
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? 'aux-dev-secret';

    this.client = new S3Client({
      endpoint,
      region: 'auto',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // MinIO requires path-style URLs
    });
  }

  /**
   * Mint a presigned PUT URL for the given key.
   * Browser uses this to upload the stem file directly — server never sees it.
   * Default 5-min TTL per the security threat model in §22.
   */
  async signPutUrl(key: string, contentType: string, ttlSeconds = 300): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  /** Mint a presigned GET URL — for stem download/playback. */
  async signGetUrl(key: string, ttlSeconds = 300): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  /** Delete a stem object. Used when stems are removed from a session. */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  /** Compose a key for a stem upload. */
  stemKey(sessionId: string, stemId: string, filename: string): string {
    // Strip directory parts from filename for safety, keep the extension.
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    return `sessions/${sessionId}/stems/${stemId}-${safeName}`;
  }
}
