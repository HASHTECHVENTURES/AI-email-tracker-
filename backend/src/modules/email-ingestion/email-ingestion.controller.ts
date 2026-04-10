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
    const internal = Boolean(req.internalApiAuth);

    if (!internal) {
      const ctx = getRequestContext(req);
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

      if (ctx.role === 'EMPLOYEE') {
        if (!ctx.employeeId) {
          throw new ForbiddenException(
            'Your account is not linked to an employee mailbox. Contact your admin.',
          );
        }
        try {
          const results = await this.emailIngestionService.runIncrementalForSingleEmployee(
            ctx.companyId,
            ctx.employeeId,
          );
          return {
            status: 'completed',
            timestamp: new Date().toISOString(),
            results,
          };
        } catch (err) {
          if (err instanceof ConflictException) {
            return {
              status: 'running',
              message:
                'Ingestion is already running. Your request was accepted and current run will continue.',
              timestamp: new Date().toISOString(),
              results: [],
            };
          }
          throw err;
        }
      }

      if (ctx.role !== 'CEO' && ctx.role !== 'HEAD') {
        throw new ForbiddenException(
          'Only CEO, department manager, linked employee mailbox, or internal API key can trigger a sync run',
        );
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
