import { Module, forwardRef } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { EmployeesModule } from '../employees/employees.module';
import { SelfTrackingModule } from '../self-tracking/self-tracking.module';
import { ConversationsModule } from '../conversations/conversations.module';

@Module({
  imports: [
    EmployeesModule,
    ConversationsModule,
    forwardRef(() => SelfTrackingModule),
  ],
  controllers: [DashboardController],
  providers: [supabaseProvider, DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
