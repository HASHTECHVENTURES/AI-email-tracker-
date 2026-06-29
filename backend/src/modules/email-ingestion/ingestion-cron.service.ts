import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConversationsService } from '../conversations/conversations.service';
import { EmailIngestionService } from './email-ingestion.service';

@Injectable()
export class IngestionCronService {
  private readonly logger = new Logger(IngestionCronService.name);

  constructor(
    private readonly emailIngestionService: EmailIngestionService,
    private readonly conversationsService: ConversationsService,
  ) {}

  /** Every 2 minutes at second 0 (UTC even minutes) — Gmail fetch, conversations, AI enrichment. */
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

  /**
   * Every 4 hours — re-apply rule guards on active Need reply threads so conversation
   * state cannot drift from message classification (no manual SQL cleanup needed).
   */
  @Cron('0 15 */4 * * *', {
    name: 'need-reply-self-heal',
    timeZone: 'UTC',
    disabled: process.env.DISABLE_INGESTION_CRON === 'true',
  })
  async runNeedReplySelfHeal(): Promise<void> {
    try {
      const result = await this.conversationsService.recomputeActiveNeedReplyThreads();
      this.logger.log(
        `Need-reply self-heal: ${result.threadsProcessed} threads (${result.updated} updated)`,
      );
    } catch (e) {
      this.logger.warn(`Need-reply self-heal failed: ${(e as Error).message}`);
    }
  }
}
