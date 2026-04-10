import { Controller, Get } from '@nestjs/common';
import { PublicRoute } from './modules/common/public-route.decorator';
import { isGeminiEnvConfigured } from './modules/common/env';

@Controller()
export class AppController {
  @PublicRoute()
  @Get()
  root(): Record<string, unknown> {
    return {
      ok: true,
      service: 'follow-up-monitor-backend',
      hint: 'This is the JSON API only. Open the app at FRONTEND_URL (e.g. http://localhost:3001).',
      try: ['/health', '/auth/status (with session)'],
    };
  }

  @PublicRoute()
  @Get('health')
  health(): { ok: boolean; gemini_configured: boolean } {
    return { ok: true, gemini_configured: isGeminiEnvConfigured() };
  }
}
