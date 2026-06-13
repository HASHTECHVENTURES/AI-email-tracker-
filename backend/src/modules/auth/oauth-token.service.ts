import { Inject, Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { retryWithBackoff } from '../common/retry.util';
import { EncryptionService } from './encryption.service';
import { getGoogleOAuthCredentials } from '../common/google-oauth-credentials';
import {
  getMicrosoftOAuthCredentials,
  MICROSOFT_MAIL_SCOPES,
} from '../common/microsoft-oauth-credentials';

export type OAuthProvider = 'google' | 'microsoft';

interface OAuthTokenRow {
  employee_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  scope: string | null;
  oauth_provider?: string | null;
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

  /** When a provider omits refresh_token on re-consent, reuse the stored one for the same provider only. */
  async getExistingRefreshTokenPlaintext(
    employeeId: string,
    expectedProvider?: OAuthProvider,
  ): Promise<string | null> {
    const tokenEmployeeId = (await this.resolveTokenEmployeeId(employeeId)) ?? employeeId;
    const { data, error } = await this.supabase
      .from('employee_oauth_tokens')
      .select('refresh_token_enc, oauth_provider')
      .eq('employee_id', tokenEmployeeId)
      .maybeSingle();
    if (error || !data) return null;
    if (expectedProvider) {
      const stored =
        (data as { oauth_provider?: string | null }).oauth_provider?.trim().toLowerCase() ===
        'microsoft'
          ? 'microsoft'
          : 'google';
      if (stored !== expectedProvider) return null;
    }
    try {
      return this.encryptionService.decrypt(
        (data as Pick<OAuthTokenRow, 'refresh_token_enc'>).refresh_token_enc,
      );
    } catch {
      return null;
    }
  }

  async getOAuthProvider(employeeId: string): Promise<OAuthProvider> {
    const tokenEmployeeId = (await this.resolveTokenEmployeeId(employeeId)) ?? employeeId;
    const { data } = await this.supabase
      .from('employee_oauth_tokens')
      .select('oauth_provider')
      .eq('employee_id', tokenEmployeeId)
      .maybeSingle();
    const p = (data as { oauth_provider?: string } | null)?.oauth_provider?.trim().toLowerCase();
    return p === 'microsoft' ? 'microsoft' : 'google';
  }

  async upsertTokens(
    employeeId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
    scope?: string,
    oauthProvider: OAuthProvider = 'google',
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
          oauth_provider: oauthProvider,
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
    const provider: OAuthProvider =
      row.oauth_provider?.trim().toLowerCase() === 'microsoft' ? 'microsoft' : 'google';
    if (provider === 'microsoft') {
      return this.refreshMicrosoft(employeeId, row);
    }
    return this.refreshGoogle(employeeId, row);
  }

  private async refreshGoogle(employeeId: string, row: OAuthTokenRow): Promise<string> {
    this.logger.log(`Refreshing Google OAuth token for employee ${employeeId}`);

    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({
      refresh_token: this.encryptionService.decrypt(row.refresh_token_enc),
    });

    try {
      const { credentials } = await retryWithBackoff(
        async () => oauth2.refreshAccessToken(),
        {
          operationName: `oauth.refresh.google(${employeeId})`,
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
        'google',
      );

      await this.supabase
        .from('employees')
        .update({ gmail_status: 'CONNECTED' })
        .eq('id', employeeId);

      return newAccessToken;
    } catch (err) {
      this.logger.error(
        `Google OAuth refresh failed for ${employeeId}: ${(err as Error).message}.`,
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

  private async refreshMicrosoft(employeeId: string, row: OAuthTokenRow): Promise<string> {
    this.logger.log(`Refreshing Microsoft OAuth token for employee ${employeeId}`);
    const { clientId, clientSecret, tenantId, redirectUri } = getMicrosoftOAuthCredentials();
    const refreshToken = this.encryptionService.decrypt(row.refresh_token_enc);

    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: MICROSOFT_MAIL_SCOPES.join(' '),
        redirect_uri: redirectUri,
      });
      const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
      const res = await retryWithBackoff(
        () =>
          fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          }),
        {
          operationName: `oauth.refresh.microsoft(${employeeId})`,
          attempts: 3,
          timeoutMs: 10_000,
        },
      );
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!data.access_token) {
        throw new Error('Microsoft refresh returned no access_token');
      }
      const newExpiry = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
      const newRefresh = data.refresh_token ?? refreshToken;

      await this.upsertTokens(
        employeeId,
        data.access_token,
        newRefresh,
        newExpiry,
        data.scope ?? row.scope ?? undefined,
        'microsoft',
      );

      await this.supabase
        .from('employees')
        .update({ gmail_status: 'CONNECTED' })
        .eq('id', employeeId);

      return data.access_token;
    } catch (err) {
      this.logger.error(`Microsoft OAuth refresh failed for ${employeeId}: ${(err as Error).message}`);
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
