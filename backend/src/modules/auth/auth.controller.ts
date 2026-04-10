import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { google } from 'googleapis';
import { OauthTokenService } from './oauth-token.service';
import { SaasAuthService } from './saas-auth.service';
import { EmployeesService } from '../employees/employees.service';
import { Request, Response } from 'express';
import { PublicRoute } from '../common/public-route.decorator';
import { AllowPendingOnboarding } from '../common/allow-pending-onboarding.decorator';
import { OauthStateService } from './oauth-state.service';
import { AuditLogService } from '../common/audit-log.service';
import { getRequestContext, type RequestContext } from '../common/request-context';
import {
  getGoogleOAuthCredentials,
  getGoogleRedirectUri,
} from '../common/google-oauth-credentials';

function mePayload(
  u: NonNullable<Request['user']>,
  managedDepartments: { id: string; name: string }[],
) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.fullName,
    company_id: u.companyId,
    company_name: u.companyName,
    role: u.role,
    department_id: u.departmentId,
    managed_department_ids: u.managedDepartmentIds ?? [],
    managed_departments: managedDepartments,
    linked_employee_id: u.linkedEmployeeId,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly oauthTokenService: OauthTokenService,
    private readonly oauthStateService: OauthStateService,
    private readonly saasAuthService: SaasAuthService,
    private readonly employeesService: EmployeesService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('status')
  @AllowPendingOnboarding()
  async status(@Req() req: Request) {
    if (req.user) {
      const u = req.user;
      let managed: { id: string; name: string }[] = [];
      if (u.role === 'HEAD' && u.managedDepartmentIds?.length) {
        managed = await this.saasAuthService.getManagedDepartmentsSummary(
          u.companyId,
          u.managedDepartmentIds,
        );
      }
      return {
        needs_onboarding: false,
        user: mePayload(u, managed),
      };
    }
    return {
      needs_onboarding: true,
      email: req.jwtEmail ?? null,
    };
  }

  @Get('me')
  async me(@Req() req: Request) {
    if (!req.user) {
      throw new UnauthorizedException('User profile not loaded');
    }
    const u = req.user;
    let managed: { id: string; name: string }[] = [];
    if (u.role === 'HEAD' && u.managedDepartmentIds?.length) {
      managed = await this.saasAuthService.getManagedDepartmentsSummary(
        u.companyId,
        u.managedDepartmentIds,
      );
    }
    return mePayload(u, managed);
  }

  @Post('onboarding')
  @AllowPendingOnboarding()
  async onboarding(
    @Req() req: Request,
    @Body() body: { full_name?: string; company_name?: string },
  ) {
    const sub = req.user?.id ?? req.jwtSub;
    const email = req.user?.email ?? req.jwtEmail;
    if (!sub || !email) {
      throw new UnauthorizedException('Invalid session for onboarding');
    }

    const fullName = body.full_name ?? '';
    const companyName = body.company_name ?? '';
    const { user, created } = await this.saasAuthService.completeOnboarding(
      sub,
      email,
      fullName,
      companyName,
    );

    let managed: { id: string; name: string }[] = [];
    if (user.role === 'HEAD' && user.managedDepartmentIds?.length) {
      managed = await this.saasAuthService.getManagedDepartmentsSummary(
        user.companyId,
        user.managedDepartmentIds,
      );
    }
    return {
      ok: true,
      created,
      user: mePayload(user, managed),
    };
  }

  /** Returns Google OAuth URL (caller redirects browser). Requires Bearer auth; employee must belong to your company. */
  @Get('gmail/authorize-url')
  async gmailAuthorizeUrl(@Req() req: Request, @Query('employee_id') employeeId: string) {
    if (!req.user) {
      throw new UnauthorizedException('Sign in required');
    }
    if (!employeeId?.trim()) {
      throw new BadRequestException('employee_id is required');
    }
    if (!this.hasValidGoogleOAuthConfig()) {
      throw new BadRequestException(
        'Google OAuth is not configured. Set valid GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in backend .env.',
      );
    }
    const normalizedEmployeeId = employeeId.trim();
    await this.employeesService.assertCanInitiateGmailOAuth(
      getRequestContext(req),
      normalizedEmployeeId,
      req.user.id,
      req.user.email?.trim().toLowerCase() ?? '',
    );
    const state = await this.oauthStateService.createState({
      employeeId: normalizedEmployeeId,
      companyId: req.user.companyId,
      userId: req.user.id,
      role: req.user.role,
    });
    return { url: this.buildGoogleOAuthUrl(state) };
  }

  private buildGoogleOAuthUrl(state: string): string {
    const { clientId, clientSecret, redirectUri } = getGoogleOAuthCredentials();
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    return oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state,
    });
  }

  @PublicRoute()
  @Get('google/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') googleOAuthError: string | undefined,
    @Query('error_description') googleErrorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');

    try {
      if (googleOAuthError) {
        const hint = googleErrorDescription
          ? `${googleOAuthError}:${googleErrorDescription}`
          : googleOAuthError;
        // eslint-disable-next-line no-console
        console.error('OAuth callback returned error from Google', hint);
        res.redirect(
          `${frontendBase}/employees?oauth_error=${encodeURIComponent(googleOAuthError)}`,
        );
        return;
      }

      if (!code || !state) {
        res.redirect(`${frontendBase}/employees?oauth_error=missing_code_or_state`);
        return;
      }
      if (!this.hasValidGoogleOAuthConfig()) {
        res.redirect(`${frontendBase}/employees?oauth_error=not_configured`);
        return;
      }

      const { clientId, clientSecret, redirectUri } = getGoogleOAuthCredentials();
      const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

      let stateToken = state.trim();
      if (stateToken.includes('%')) {
        try {
          stateToken = decodeURIComponent(stateToken);
        } catch {
          /* use trimmed original */
        }
      }

      const payload = await this.oauthStateService.verifyAndConsumeState(stateToken);
      const actor = await this.saasAuthService.findProfileByAuthId(payload.user_id);
      if (!actor || actor.companyId !== payload.company_id) {
        throw new UnauthorizedException('invalid_actor_context');
      }
      const oauthCtx: RequestContext = {
        companyId: actor.companyId,
        role: actor.role,
        userId: actor.id,
        employeeId: actor.role === 'EMPLOYEE' ? actor.linkedEmployeeId ?? undefined : undefined,
        departmentId: actor.role === 'HEAD' ? actor.departmentId ?? undefined : undefined,
      };
      await this.employeesService.assertCanInitiateGmailOAuth(
        oauthCtx,
        payload.employee_id,
        actor.id,
        actor.email?.trim().toLowerCase() ?? '',
      );

      const validEmployee = await this.employeesService.employeeExists(payload.employee_id);
      if (!validEmployee) {
        throw new BadRequestException('invalid_employee');
      }

      const { tokens } = await oauth2.getToken({
        code: code.trim(),
        redirect_uri: redirectUri,
      });
      if (!tokens.access_token) {
        throw new BadRequestException('missing_access_token');
      }

      let refreshToken = tokens.refresh_token;
      if (!refreshToken) {
        refreshToken =
          (await this.oauthTokenService.getExistingRefreshTokenPlaintext(
            payload.employee_id,
          )) ?? undefined;
      }
      if (!refreshToken) {
        throw new BadRequestException('missing_refresh_token');
      }

      await this.oauthTokenService.upsertTokens(
        payload.employee_id,
        tokens.access_token,
        refreshToken,
        new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        tokens.scope ?? undefined,
      );

      await this.employeesService.ensureMailSyncAfterOAuth(payload.employee_id);
      await this.auditLogService.log({
        userId: actor.id,
        companyId: actor.companyId,
        action: 'gmail_connect',
        entity: 'employee',
        entityId: payload.employee_id,
      });

      const mailboxType = await this.employeesService.getMailboxType(payload.employee_id);
      let nextPath = '/employees';
      if (mailboxType === 'SELF') {
        nextPath = '/my-email';
      } else if (actor.role === 'HEAD') {
        /** Manager team-mail OAuth completes here (dedicated sidebar page; not mixed with personal My mail). */
        nextPath = '/team-mail-sync';
      }
      /** Popup-friendly landing: notifies opener then closes; avoids losing the main tab Supabase session. */
      const done = new URL(`${frontendBase}/auth/gmail-oauth-done`);
      done.searchParams.set('connected', '1');
      done.searchParams.set('employee_id', payload.employee_id);
      done.searchParams.set('next', nextPath);
      res.redirect(done.toString());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OAuth callback failed', err);
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? String((err as { response?: { data?: unknown } }).response?.data ?? '')
          : (err as Error).message;
      // eslint-disable-next-line no-console
      console.error('OAuth callback failure detail', detail);
      res.redirect(`${frontendBase}/employees?oauth_error=exchange_failed`);
    }
  }

  private hasValidGoogleOAuthConfig(): boolean {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
    const redirectUri = getGoogleRedirectUri();
    const invalidValues = new Set(['', 'local-dev-placeholder']);
    return (
      !invalidValues.has(clientId) &&
      !invalidValues.has(clientSecret) &&
      redirectUri.length > 0
    );
  }
}
