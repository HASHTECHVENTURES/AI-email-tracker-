import { ConflictException, Controller, ForbiddenException, Get, Req } from '@nestjs/common';
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

    try {
      const results = await this.emailIngestionService.runIncrementalCycle({ force: internal });
      return {
        status: 'completed',
        timestamp: new Date().toISOString(),
        results,
      };
    } catch (err) {
      if (err instanceof ConflictException) {
        return {
          status: 'running',
          message: 'Ingestion is already running. Your request was accepted and current run will continue.',
          timestamp: new Date().toISOString(),
          results: [],
        };
      }
      throw err;
    }
  }
}
