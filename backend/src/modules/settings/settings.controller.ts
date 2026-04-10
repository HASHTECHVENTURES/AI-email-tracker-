import { BadRequestException, Body, Controller, ForbiddenException, Get, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { CompanyPolicyService } from '../company-policy/company-policy.service';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly companyPolicyService: CompanyPolicyService,
  ) {}

  @Get()
  async getAll(@Req() req: Request) {
    const ctx = getRequestContext(req);
    const base = await this.settingsService.getAll();
    const flags = await this.companyPolicyService.getFlags(ctx.companyId);
    return { ...base, company_admin_ai_enabled: flags.admin_ai_enabled };
  }

  @Get('runtime')
  async getRuntime(@Req() req: Request) {
    getRequestContext(req);
    return this.settingsService.getRuntimeStatus();
  }

  @Put()
  async update(@Req() req: Request, @Body() body: { key: string; value: string }) {
    const ctx = getRequestContext(req);
    if (body.key === 'email_ingest_without_ai_confirmed' && ctx.role !== 'CEO') {
      throw new ForbiddenException('Only the CEO can confirm import without Inbox AI');
    }
    await this.settingsService.set(body.key, body.value);
    return { status: 'ok' };
  }

  /** CEO only: turn all email crawl settings on/off, or all AI settings on/off, in one request. */
  @Put('masters')
  async setMasters(
    @Req() req: Request,
    @Body() body: { email?: boolean; ai?: boolean },
  ) {
    getRequestContext(req);
    if (req.user?.role !== 'CEO') {
      throw new ForbiddenException('Only the CEO can change company master switches');
    }
    if (body.email === undefined && body.ai === undefined) {
      throw new BadRequestException('Provide at least one of: email, ai');
    }
    await this.settingsService.setCompanyMasters({ email: body.email, ai: body.ai });
    return { status: 'ok' };
  }
}
