import { Controller, Get } from '@nestjs/common';
import { EmailIngestionService } from './email-ingestion.service';

@Controller('email-ingestion')
export class EmailIngestionController {
  constructor(private readonly emailIngestionService: EmailIngestionService) {}

  @Get('run')
  async runIngestion() {
    const results = await this.emailIngestionService.runIncrementalCycle();
    return {
      status: 'completed',
      timestamp: new Date().toISOString(),
      results,
    };
  }
}
