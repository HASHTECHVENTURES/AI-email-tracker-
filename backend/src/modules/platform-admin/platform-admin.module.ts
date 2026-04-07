import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  controllers: [PlatformAdminController],
  providers: [supabaseProvider, PlatformAdminService, PlatformAdminGuard],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
