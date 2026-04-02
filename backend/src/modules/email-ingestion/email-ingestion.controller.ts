import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { EmailIngestionService } from './email-ingestion.service';
import { getRequestContext } from '../common/request-context';

@Controller('email-ingestion')
export class EmailIngestionController {
  constructor(private readonly emailIngestionService: EmailIngestionService) {}

  @Get('run')
  async runIngestion(@Req() req: Request) {
    if (!req.internalApiAuth) {
      const ctx = getRequestContext(req);
      if (ctx.role !== 'CEO') {
        throw new ForbiddenException('Only CEO or internal API key can trigger ingestion');
      }
    }
    const results = await this.emailIngestionService.runIncrementalCycle();
    return {
      status: 'completed',
      timestamp: new Date().toISOString(),
      results,
    };
  }
}
