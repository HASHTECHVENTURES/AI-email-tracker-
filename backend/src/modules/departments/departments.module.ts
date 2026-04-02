import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';

@Module({
  controllers: [DepartmentsController],
  providers: [supabaseProvider, DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
