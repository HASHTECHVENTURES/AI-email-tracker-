import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

interface DepartmentRow {
  id: string;
  company_id: string;
  name: string;
  created_at: string;
}

@Injectable()
export class DepartmentsService {
  private readonly logger = new Logger(DepartmentsService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async create(companyId: string, name: string): Promise<DepartmentRow> {
    const { data, error } = await this.supabase
      .from('departments')
      .insert({ company_id: companyId, name })
      .select('*')
      .single();
    if (error) {
      this.logger.error('Failed to create department', error.message);
      throw error;
    }
    return data as DepartmentRow;
  }

  async list(companyId: string): Promise<DepartmentRow[]> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('*')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.error('Failed to list departments', error.message);
      throw error;
    }
    return (data ?? []) as DepartmentRow[];
  }

  async delete(companyId: string, id: string): Promise<void> {
    const { error } = await this.supabase
      .from('departments')
      .delete()
      .eq('company_id', companyId)
      .eq('id', id);
    if (error) {
      this.logger.error('Failed to delete department', error.message);
      throw error;
    }
  }
}
