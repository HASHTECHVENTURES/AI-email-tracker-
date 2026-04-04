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
import { getGoogleOAuthCredentials } from '../common/google-oauth-credentials';

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
      return {
        needs_onboarding: false,
        user: {
          id: u.id,
          email: u.email,
          full_name: u.fullName,
          company_id: u.companyId,
          company_name: u.companyName,
          role: u.role,
          department_id: u.departmentId,
          linked_employee_id: u.linkedEmployeeId,
        },
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
    return {
      id: u.id,
      email: u.email,
      full_name: u.fullName,
      company_id: u.companyId,
      company_name: u.companyName,
      role: u.role,
      department_id: u.departmentId,
      linked_employee_id: u.linkedEmployeeId,
    };
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

    return {
      ok: true,
      created,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
        company_id: user.companyId,
        company_name: user.companyName,
        role: user.role,
        department_id: user.departmentId,
        linked_employee_id: user.linkedEmployeeId,
      },
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
    await this.employeesService.assertCanInitiateGmailOAuth(req.user, normalizedEmployeeId);
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

    try {
      const payload = await this.oauthStateService.verifyAndConsumeState(state);
      const actor = await this.saasAuthService.findProfileByAuthId(payload.user_id);
      if (!actor || actor.companyId !== payload.company_id) {
        throw new UnauthorizedException('invalid_actor_context');
      }
      await this.employeesService.assertCanInitiateGmailOAuth(actor, payload.employee_id);

      const validEmployee = await this.employeesService.employeeExists(payload.employee_id);
      if (!validEmployee) {
        throw new BadRequestException('invalid_employee');
      }

      const { tokens } = await oauth2.getToken(code);
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

      res.redirect(
        `${frontendBase}/employees?connected=1&employee_id=${encodeURIComponent(payload.employee_id)}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OAuth callback failed', err);
      const code =
        err && typeof err === 'object' && 'response' in err
          ? String((err as { response?: { data?: unknown } }).response?.data ?? '')
          : (err as Error).message;
      // eslint-disable-next-line no-console
      console.error('OAuth callback failure detail', code);
      res.redirect(`${frontendBase}/employees?oauth_error=exchange_failed`);
    }
  }

  private hasValidGoogleOAuthConfig(): boolean {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
    const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() ?? '';
    const invalidValues = new Set(['', 'local-dev-placeholder']);
    return (
      !invalidValues.has(clientId) &&
      !invalidValues.has(clientSecret) &&
      !invalidValues.has(redirectUri)
    );
  }
}
