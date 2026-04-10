import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertRequiredEnv, isGeminiEnvConfigured } from './modules/common/env';
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

function isGoogleOAuthCallback(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const path = req.path || '';
  return path === '/auth/google/callback' || path.endsWith('/auth/google/callback');
}

async function bootstrap() {
  assertRequiredEnv();
  // Helps verify Railway/env: logs whether the *running* process sees a Gemini key (value is never logged).
  // If this says "not set" but Variables has GEMINI_API_KEY, redeploy or attach vars to this service.
  console.log(
    `[bootstrap] Gemini env: ${isGeminiEnvConfigured() ? 'configured (Inbox AI can use API key)' : 'NOT SET — add GEMINI_API_KEY to this service and redeploy'}`,
  );
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Railway / reverse proxies: correct client IP for rate limits and forwarded proto.
  app.set('trust proxy', 1);
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests', code: 'RATE_LIMITED' },
    skip: (req) => isGoogleOAuthCallback(req),
  });
  app.use(['/auth', '/email-ingestion/run', '/conversations'], limiter);
  app.enableCors({
    // Local dev, LAN, optional FRONTEND_URL / CORS_ORIGINS, and Railway-hosted HTTPS apps.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      // Any local dev port (Next default 3001, or custom) — avoids "Failed to fetch" from strict CORS.
      if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true);
      const extras =
        process.env.CORS_ORIGINS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      if (extras.includes(origin)) return cb(null, true);
      const front = process.env.FRONTEND_URL?.replace(/\/$/, '');
      if (front && origin === front) return cb(null, true);
      if (origin === 'http://localhost:3001' || origin === 'http://127.0.0.1:3001') return cb(null, true);
      if (/^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:3001$/.test(origin)) return cb(null, true);
      if (/^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:3001$/.test(origin)) return cb(null, true);
      if (/^https:\/\/[a-z0-9-]+\.up\.railway\.app$/i.test(origin)) return cb(null, true);
      if (/^https:\/\/[a-z0-9.-]+\.vercel\.app$/i.test(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-manager-department-id'],
    credentials: true,
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
