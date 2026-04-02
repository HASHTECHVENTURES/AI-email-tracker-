import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { supabaseProvider } from '../common/supabase.provider';
import { OauthTokenService } from './oauth-token.service';
import { AuthController } from './auth.controller';
import { SaasAuthService } from './saas-auth.service';
import { AppAuthGuard } from './app-auth.guard';
import { EmployeesModule } from '../employees/employees.module';
import { EncryptionService } from './encryption.service';
import { OauthStateService } from './oauth-state.service';
import { AuditLogService } from '../common/audit-log.service';

@Module({
  imports: [EmployeesModule],
  controllers: [AuthController],
  providers: [
    supabaseProvider,
    OauthTokenService,
    EncryptionService,
    OauthStateService,
    AuditLogService,
    SaasAuthService,
    AppAuthGuard,
    { provide: APP_GUARD, useExisting: AppAuthGuard },
  ],
  exports: [OauthTokenService, EncryptionService, OauthStateService, supabaseProvider, AppAuthGuard],
})
export class AuthModule {}
