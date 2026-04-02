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
    // Allow both local dev and LAN access to the frontend.
    // If you want to tighten this later, replace with your exact deployed URL(s).
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === 'http://localhost:3001' || origin === 'http://127.0.0.1:3001') return cb(null, true);
      // Allow http://192.168.x.x:3001 and http://10.x.x.x:3001 (common LAN ranges)
      if (/^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:3001$/.test(origin)) return cb(null, true);
      if (/^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:3001$/.test(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    credentials: true,
  });
  // Bind on all interfaces so other devices can reach it.
  await app.listen(3000, '0.0.0.0');
}

void bootstrap();
