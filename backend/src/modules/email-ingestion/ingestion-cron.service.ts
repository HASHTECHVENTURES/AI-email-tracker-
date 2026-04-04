import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmailIngestionService } from './email-ingestion.service';

// #region agent log
function agentCronLog(payload: Record<string, unknown>): void {
  void fetch('http://127.0.0.1:7758/ingest/3f959e88-e323-4293-b212-b53185d6de50', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6b8d53' },
    body: JSON.stringify({
      sessionId: '6b8d53',
      timestamp: Date.now(),
      hypothesisId: 'H4',
      ...payload,
    }),
  }).catch(() => {});
}
// #endregion

@Injectable()
export class IngestionCronService implements OnModuleInit {
  private readonly logger = new Logger(IngestionCronService.name);

  constructor(private readonly emailIngestionService: EmailIngestionService) {}

  onModuleInit(): void {
    // #region agent log
    agentCronLog({
      location: 'ingestion-cron.service.ts:onModuleInit',
      message: 'ingestion cron env',
      data: {
        cronDisabledEnv: process.env.DISABLE_INGESTION_CRON === 'true',
      },
    });
    // #endregion
  }

  /** Every 2 minutes at second 0 — Gmail fetch, conversations, AI enrichment, reports. */
  @Cron('0 */2 * * * *', {
    name: 'gmail-ingestion',
    disabled: process.env.DISABLE_INGESTION_CRON === 'true',
  })
  async runScheduledIngestion(): Promise<void> {
    // #region agent log
    agentCronLog({
      location: 'ingestion-cron.service.ts:runScheduledIngestion',
      message: 'cron tick fired',
      data: { fired: true },
    });
    // #endregion
    try {
      await this.emailIngestionService.runIncrementalCycle();
    } catch (e) {
      if (e instanceof ConflictException) {
        this.logger.debug('Ingestion skipped — lock held');
        // #region agent log
        agentCronLog({
          location: 'ingestion-cron.service.ts:catch',
          message: 'ingestion skipped lock',
          data: { conflict: true },
        });
        // #endregion
        return;
      }
      this.logger.warn(`Scheduled ingestion failed: ${(e as Error).message}`);
      // #region agent log
      agentCronLog({
        location: 'ingestion-cron.service.ts:catch',
        message: 'scheduled ingestion failed',
        data: { errMsg: (e as Error).message?.slice(0, 200) },
      });
      // #endregion
    }
  }
}
