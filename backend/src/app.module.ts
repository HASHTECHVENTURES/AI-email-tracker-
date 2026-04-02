import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EmployeesModule } from './modules/employees/employees.module';
import { EmailIngestionModule } from './modules/email-ingestion/email-ingestion.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { FollowupModule } from './modules/followup/followup.module';
import { AiEnrichmentModule } from './modules/ai-enrichment/ai-enrichment.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SettingsModule } from './modules/settings/settings.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { SystemModule } from './modules/system/system.module';
import { TeamAlertsModule } from './modules/team-alerts/team-alerts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AuthModule,
    EmployeesModule,
    EmailIngestionModule,
    ConversationsModule,
    FollowupModule,
    AiEnrichmentModule,
    AlertsModule,
    DashboardModule,
    SettingsModule,
    DepartmentsModule,
    SystemModule,
    TeamAlertsModule,
  ],
})
export class AppModule {}
