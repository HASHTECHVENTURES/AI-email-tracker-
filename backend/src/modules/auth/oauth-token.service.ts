import { Inject, Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { retryWithBackoff } from '../common/retry.util';
import { EncryptionService } from './encryption.service';
import { getGoogleOAuthCredentials } from '../common/google-oauth-credentials';

interface OAuthTokenRow {
  employee_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  scope: string | null;
}

@Injectable()
export class OauthTokenService {
  private readonly logger = new Logger(OauthTokenService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly encryptionService: EncryptionService,
  ) {}

  private createOAuth2Client() {
    const { clientId, clientSecret, redirectUri } = getGoogleOAuthCredentials();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Backward-compat: OAuth may be connected on an alias employee row sharing the same email.
   * Resolve to the row that actually has a token before reads/refresh.
   */
  private async resolveTokenEmployeeId(employeeId: string): Promise<string | null> {
    const direct = await this.supabase
      .from('employee_oauth_tokens')
      .select('employee_id')
      .eq('employee_id', employeeId)
      .maybeSingle();
    if (!direct.error && direct.data) return employeeId;

    const { data: base } = await this.supabase
      .from('employees')
      .select('company_id, email')
      .eq('id', employeeId)
      .maybeSingle();
    const companyId = (base as { company_id?: string } | null)?.company_id;
    const email = (base as { email?: string } | null)?.email?.trim().toLowerCase();
    if (!companyId || !email) return null;

    const { data: aliases } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('email', email);
    const ids = ((aliases ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return null;

    const { data: tokenRow } = await this.supabase
      .from('employee_oauth_tokens')
      .select('employee_id, updated_at')
      .in('employee_id', ids)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (tokenRow as { employee_id?: string } | null)?.employee_id ?? null;
  }

  async hasToken(employeeId: string): Promise<boolean> {
    const resolved = await this.resolveTokenEmployeeId(employeeId);
    return resolved != null;
  }

  async getValidAccessToken(employeeId: string): Promise<string> {
    const tokenEmployeeId = (await this.resolveTokenEmployeeId(employeeId)) ?? employeeId;
    const { data, error } = await this.supabase
      .from('employee_oauth_tokens')
      .select('*')
      .eq('employee_id', tokenEmployeeId)
      .single();

    if (error || !data) {
      throw new Error(`No OAuth token found for employee ${employeeId}`);
    }

    const row = data as OAuthTokenRow;
    const expiresAt = new Date(row.expires_at).getTime();
    const bufferMs = 60_000;

    if (Date.now() + bufferMs >= expiresAt) {
      return this.refresh(tokenEmployeeId, row);
    }

    return this.encryptionService.decrypt(row.access_token_enc);
  }

  async getRefreshToken(employeeId: string): Promise<string> {
    const tokenEmployeeId = (await this.resolveTokenEmployeeId(employeeId)) ?? employeeId;
    const { data, error } = await this.supabase
      .from('employee_oauth_tokens')
      .select('refresh_token_enc')
      .eq('employee_id', tokenEmployeeId)
      .single();

    if (error || !data) {
      throw new Error(`No refresh token found for employee ${employeeId}`);
    }

    return this.encryptionService.decrypt(
      (data as Pick<OAuthTokenRow, 'refresh_token_enc'>).refresh_token_enc,
    );
  }

  /** When Google omits refresh_token on re-consent, reuse the stored one. */
  async getExistingRefreshTokenPlaintext(employeeId: string): Promise<string | null> {
    const tokenEmployeeId = (await this.resolveTokenEmployeeId(employeeId)) ?? employeeId;
    const { data, error } = await this.supabase
      .from('employee_oauth_tokens')
      .select('refresh_token_enc')
      .eq('employee_id', tokenEmployeeId)
      .maybeSingle();
    if (error || !data) return null;
    try {
      return this.encryptionService.decrypt(
        (data as Pick<OAuthTokenRow, 'refresh_token_enc'>).refresh_token_enc,
      );
    } catch {
      return null;
    }
  }

  async upsertTokens(
    employeeId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
    scope?: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from('employee_oauth_tokens')
      .upsert(
        {
          employee_id: employeeId,
          access_token_enc: this.encryptionService.encrypt(accessToken),
          refresh_token_enc: this.encryptionService.encrypt(refreshToken),
          expires_at: expiresAt.toISOString(),
          scope: scope ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'employee_id' },
      );

    if (error) {
      this.logger.error(`Failed to upsert tokens for ${employeeId}`, error.message);
      throw error;
    }
  }

  private async refresh(employeeId: string, row: OAuthTokenRow): Promise<string> {
    this.logger.log(`Refreshing OAuth token for employee ${employeeId}`);

    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({
      refresh_token: this.encryptionService.decrypt(row.refresh_token_enc),
    });

    try {
      const { credentials } = await retryWithBackoff(
        async () => oauth2.refreshAccessToken(),
        {
          operationName: `oauth.refresh(${employeeId})`,
          attempts: 3,
          timeoutMs: 10_000,
          onRetry: (attempt, err, delayMs) => {
            this.logger.warn(
              `Retrying OAuth refresh attempt ${attempt + 1} in ${delayMs}ms: ${(err as Error).message}`,
            );
          },
        },
      );
      const newAccessToken = credentials.access_token!;
      const newExpiry = new Date(credentials.expiry_date ?? Date.now() + 3600_000);

      await this.upsertTokens(
        employeeId,
        newAccessToken,
        this.encryptionService.decrypt(row.refresh_token_enc),
        newExpiry,
        row.scope ?? undefined,
      );

      await this.supabase
        .from('employees')
        .update({ gmail_status: 'CONNECTED' })
        .eq('id', employeeId);

      return newAccessToken;
    } catch (err) {
      this.logger.error(
        `OAuth refresh failed for ${employeeId}: ${(err as Error).message}. ` +
          'If "unauthorized_client": verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET match the Google Cloud project, ' +
          'and the OAuth consent screen is published (not Testing). Reconnect Gmail from the portal.',
      );
      const msg = String((err as Error).message || '').toLowerCase();
      const status =
        msg.includes('invalid_grant') || msg.includes('revoked') ? 'REVOKED' : 'EXPIRED';
      await this.supabase
        .from('employees')
        .update({ gmail_status: status })
        .eq('id', employeeId);
      throw new Error(`Token refresh failed for employee ${employeeId}: ${(err as Error).message}`);
    }
  }
}
