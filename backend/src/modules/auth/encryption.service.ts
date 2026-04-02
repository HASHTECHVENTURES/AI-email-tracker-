import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

type Payload = {
  iv: string;
  tag: string;
  data: string;
};

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);

  private getKey(): Buffer {
    const raw = process.env.ENCRYPTION_KEY?.trim();
    if (!raw) {
      throw new Error('ENCRYPTION_KEY is required');
    }
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    try {
      const base64 = Buffer.from(raw, 'base64');
      if (base64.length === 32) return base64;
    } catch {
      // fall through
    }
    const utf8 = Buffer.from(raw, 'utf8');
    if (utf8.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes (utf8/base64/hex)');
    }
    return utf8;
  }

  encrypt(text: string): string {
    const key = this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload: Payload = {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  decrypt(cipherText: string): string {
    try {
      const decoded = Buffer.from(cipherText, 'base64').toString('utf8');
      const payload = JSON.parse(decoded) as Payload;
      const key = this.getKey();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(payload.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch (err) {
      this.logger.error(`decrypt failed: ${(err as Error).message}`);
      throw new Error('Failed to decrypt token');
    }
  }
}
