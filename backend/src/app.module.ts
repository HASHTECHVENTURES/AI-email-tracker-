import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EmployeesModule } from './modules/employees/employees.module';
import { EmailIngestionModule } from './modules/email-ingestion/email-ingestion.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { FollowupModule } from './modules/followup/followup.module';
import { AiEnrichmentModule } from './modules/ai-enrichment/ai-enrichment.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SettingsModule } from './modules/settings/settings.module';
import { InternalApiKeyGuard } from './modules/common/internal-api-key.guard';
import { DepartmentsModule } from './modules/departments/departments.module';
import { SystemModule } from './modules/system/system.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: InternalApiKeyGuard,
    },
  ],
})
export class AppModule {}
