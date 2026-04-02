import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { AuditLogService } from '../common/audit-log.service';
import { EmployeesService } from './employees.service';
import { EmployeesController } from './employees.controller';

@Module({
  controllers: [EmployeesController],
  providers: [supabaseProvider, AuditLogService, EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
