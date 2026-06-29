import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { SettingsModule } from '../settings/settings.module';
import { UsageModule } from '../usage/usage.module';
import { AuthModule } from '../auth/auth.module';
import { EmployeesModule } from '../employees/employees.module';

@Module({
  imports: [SettingsModule, UsageModule, AuthModule, EmployeesModule],
  controllers: [PlatformAdminController],
  providers: [supabaseProvider, PlatformAdminService, PlatformAdminGuard],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
