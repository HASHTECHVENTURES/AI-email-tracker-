import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { EmployeesService } from './employees.service';
import { EmployeesController } from './employees.controller';

@Module({
  controllers: [EmployeesController],
  providers: [supabaseProvider, EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
