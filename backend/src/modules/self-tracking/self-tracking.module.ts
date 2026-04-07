import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { EmployeesModule } from '../employees/employees.module';
import { SelfTrackingService } from './self-tracking.service';
import { SelfTrackingController } from './self-tracking.controller';

@Module({
  imports: [EmployeesModule],
  controllers: [SelfTrackingController],
  providers: [supabaseProvider, SelfTrackingService],
  exports: [SelfTrackingService],
})
export class SelfTrackingModule {}
