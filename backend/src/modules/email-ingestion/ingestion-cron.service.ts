import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmailIngestionService } from './email-ingestion.service';

@Injectable()
export class IngestionCronService {
  private readonly logger = new Logger(IngestionCronService.name);

  constructor(private readonly emailIngestionService: EmailIngestionService) {}

  /** Every 2 minutes at second 0 (UTC even minutes) — Gmail fetch, conversations, AI enrichment, reports. */
  @Cron('0 */2 * * * *', {
    name: 'gmail-ingestion',
    timeZone: 'UTC',
    disabled: process.env.DISABLE_INGESTION_CRON === 'true',
  })
  async runScheduledIngestion(): Promise<void> {
    try {
      await this.emailIngestionService.runIncrementalCycle();
    } catch (e) {
      if (e instanceof ConflictException) {
        this.logger.debug('Ingestion skipped — lock held');
        return;
      }
      this.logger.warn(`Scheduled ingestion failed: ${(e as Error).message}`);
    }
  }
}
