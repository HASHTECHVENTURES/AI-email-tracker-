import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertRequiredEnv } from './modules/common/env';
import rateLimit from 'express-rate-limit';

async function bootstrap() {
  assertRequiredEnv();
  const app = await NestFactory.create(AppModule);
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests', code: 'RATE_LIMITED' },
  });
  app.use(['/auth', '/email-ingestion/run', '/conversations'], limiter);
  app.enableCors({
    // Local dev, LAN, optional FRONTEND_URL / CORS_ORIGINS, and Railway-hosted HTTPS apps.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
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
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    credentials: true,
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
