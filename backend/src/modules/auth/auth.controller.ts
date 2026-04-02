import { Controller, Get, Query, Res } from '@nestjs/common';
import { google } from 'googleapis';
import { OauthTokenService } from './oauth-token.service';
import { Response } from 'express';
import { PublicRoute } from '../common/public-route.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly oauthTokenService: OauthTokenService) {}

  @PublicRoute()
  @Get('google')
  getAuthUrl(@Query('employee_id') employeeId: string, @Res() res: Response) {
    if (!employeeId) {
      res.status(400).json({ error: 'employee_id query parameter is required' });
      return;
    }

    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );

    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: employeeId,
    });

    res.redirect(url);
  }

  @PublicRoute()
  @Get('google/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') employeeId: string,
    @Res() res: Response,
  ) {
    if (!code || !employeeId) {
      res.status(400).json({ error: 'Missing code or state (employee_id)' });
      return;
    }

    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );

    try {
      const { tokens } = await oauth2.getToken(code);

      await this.oauthTokenService.upsertTokens(
        employeeId,
        tokens.access_token!,
        tokens.refresh_token!,
        new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        tokens.scope ?? undefined,
      );

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      res.redirect(
        `${frontendUrl}/employees?connected=1&employee_id=${encodeURIComponent(employeeId)}`,
      );
    } catch (err) {
      res.status(500).json({
        error: 'Failed to exchange token',
        detail: (err as Error).message,
      });
    }
  }
}
