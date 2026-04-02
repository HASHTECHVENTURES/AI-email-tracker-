import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import type { EmployeeRole } from '../common/types';

type OauthStatePayload = {
  employee_id: string;
  company_id: string;
  user_id: string;
  role: EmployeeRole;
  nonce: string;
  exp: number;
};

@Injectable()
export class OauthStateService {
  private readonly logger = new Logger(OauthStateService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private getSecret(): string {
    const s = process.env.OAUTH_STATE_SECRET?.trim();
    return s || process.env.INTERNAL_API_KEY?.trim() || '';
  }

  private sign(data: string): string {
    const secret = this.getSecret();
    if (!secret) throw new Error('OAUTH_STATE_SECRET (or INTERNAL_API_KEY) is required');
    return createHmac('sha256', secret).update(data).digest('base64url');
  }

  private encode(obj: OauthStatePayload): string {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  }

  private decode(s: string): OauthStatePayload {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as OauthStatePayload;
  }

  async createState(input: {
    employeeId: string;
    companyId: string;
    userId: string;
    role: EmployeeRole;
  }): Promise<string> {
    const nonce = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const payload: OauthStatePayload = {
      employee_id: input.employeeId,
      company_id: input.companyId,
      user_id: input.userId,
      role: input.role,
      nonce,
      exp,
    };
    const payloadB64 = this.encode(payload);
    const sig = this.sign(payloadB64);
    const { error } = await this.supabase.from('oauth_state_nonces').insert({
      nonce,
      auth_user_id: input.userId,
      employee_id: input.employeeId,
      company_id: input.companyId,
      expires_at: new Date(exp * 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
    if (error) throw new Error('state_nonce_store_failed');
    return `${payloadB64}.${sig}`;
  }

  async verifyAndConsumeState(token: string): Promise<OauthStatePayload> {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) throw new Error('invalid_state_format');
    const expected = this.sign(payloadB64);
    if (
      expected.length !== sig.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
    ) {
      throw new Error('invalid_state_signature');
    }
    const payload = this.decode(payloadB64);
    if (!payload.nonce || !payload.user_id || !payload.company_id || !payload.employee_id) {
      throw new Error('invalid_state_payload');
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('expired_state');
    }

    const { data } = await this.supabase
      .from('oauth_state_nonces')
      .select('nonce, used_at, expires_at, auth_user_id, employee_id, company_id')
      .eq('nonce', payload.nonce)
      .maybeSingle();
    const row = data as
      | {
          nonce: string;
          used_at: string | null;
          expires_at: string;
          auth_user_id: string;
          employee_id: string;
          company_id: string;
        }
      | null;
    if (!row) throw new Error('state_nonce_missing');
    if (row.used_at) throw new Error('state_nonce_used');
    if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('state_nonce_expired');
    if (
      row.auth_user_id !== payload.user_id ||
      row.employee_id !== payload.employee_id ||
      row.company_id !== payload.company_id
    ) {
      throw new Error('state_nonce_mismatch');
    }

    const { error } = await this.supabase
      .from('oauth_state_nonces')
      .update({ used_at: new Date().toISOString() })
      .eq('nonce', payload.nonce)
      .is('used_at', null);
    if (error) {
      this.logger.warn(`nonce consume update failed: ${error.message}`);
      throw new Error('state_nonce_consume_failed');
    }

    return payload;
  }
}
