import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from './supabase.provider';

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async log(params: {
    userId: string;
    companyId: string;
    action: string;
    entity: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.supabase.from('audit_logs').insert({
      user_id: params.userId,
      company_id: params.companyId,
      action: params.action,
      entity: params.entity,
      entity_id: params.entityId ?? null,
      metadata: params.metadata ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      this.logger.warn(`audit log failed (${params.action}): ${error.message}`);
    }
  }
}
