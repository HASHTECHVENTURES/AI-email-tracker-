import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { EmailIngestionService } from './email-ingestion.service';
import { getRequestContext } from '../common/request-context';
import { SettingsService } from '../settings/settings.service';

@Controller('email-ingestion')
export class EmailIngestionController {
  constructor(
    private readonly emailIngestionService: EmailIngestionService,
    private readonly settingsService: SettingsService,
  ) {}

  @Get('run')
  async runIngestion(@Req() req: Request) {
    if (!req.internalApiAuth) {
      const ctx = getRequestContext(req);
      if (ctx.role !== 'CEO') {
        throw new ForbiddenException('Only CEO or internal API key can trigger ingestion');
      }
    }

    const internal = Boolean(req.internalApiAuth);
    // #region agent log
    void fetch('http://127.0.0.1:7758/ingest/3f959e88-e323-4293-b212-b53185d6de50', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6b8d53' },
      body: JSON.stringify({
        sessionId: '6b8d53',
        timestamp: Date.now(),
        hypothesisId: 'H_manual',
        location: 'email-ingestion.controller.ts:runIngestion',
        message: 'GET email-ingestion/run invoked',
        data: { internal },
      }),
    }).catch(() => {});
    // #endregion
    if (!internal) {
      const s = await this.settingsService.getAll();
      if (!s.email_crawl_enabled) {
        return {
          status: 'skipped',
          reason: 'email_crawl_disabled',
          message: 'Mailbox crawl is off in Settings. Turn it on to fetch Gmail again.',
          timestamp: new Date().toISOString(),
          results: [],
        };
      }
    }

    const results = await this.emailIngestionService.runIncrementalCycle({ force: internal });
    return {
      status: 'completed',
      timestamp: new Date().toISOString(),
      results,
    };
  }
}
