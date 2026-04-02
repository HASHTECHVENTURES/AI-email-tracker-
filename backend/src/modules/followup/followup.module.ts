import { Module } from '@nestjs/common';
import { FollowupService } from './followup.service';

@Module({
  providers: [FollowupService],
  exports: [FollowupService],
})
export class FollowupModule {}
