import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { AuditLogService } from '../common/audit-log.service';
import { TeamAlertsService } from './team-alerts.service';
import { TeamAlertsController } from './team-alerts.controller';

@Module({
  controllers: [TeamAlertsController],
  providers: [supabaseProvider, AuditLogService, TeamAlertsService],
})
export class TeamAlertsModule {}
