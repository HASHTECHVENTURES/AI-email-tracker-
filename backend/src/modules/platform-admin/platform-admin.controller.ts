import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformAdminGuard, isPlatformAdminUser } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { SettingsService } from '../settings/settings.service';
import { CompanyBillingService } from '../usage/company-billing.service';

@Controller('platform-admin')
export class PlatformAdminController {
  constructor(
    private readonly platformAdminService: PlatformAdminService,
    private readonly settingsService: SettingsService,
    private readonly companyBillingService: CompanyBillingService,
  ) {}

  /** Any authenticated user: whether they may use platform admin APIs. */
  @Get('me')
  me(@Req() req: Request) {
    return { allowed: isPlatformAdminUser(req.user) };
  }

  @Get('stats')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  stats() {
    return this.platformAdminService.getStats();
  }

  @Get('companies')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  companies() {
    return this.platformAdminService.listCompanies();
  }

  @Post('companies')
  @UseGuards(PlatformAdminGuard)
  createCompany(
    @Body()
    body: {
      name?: string;
      ceo_email?: string;
      ceo_password?: string;
    },
  ) {
    return this.platformAdminService.createCompany({
      name: body.name ?? '',
      ceoEmail: body.ceo_email,
      ceoPassword: body.ceo_password,
    });
  }

  @Patch('companies/:id/flags')
  @UseGuards(PlatformAdminGuard)
  async patchFlags(
    @Param('id') id: string,
    @Body()
    body: {
      admin_ai_enabled?: boolean;
      admin_email_crawl_enabled?: boolean;
    },
  ) {
    await this.platformAdminService.updateCompanyFlags(id, {
      admin_ai_enabled: body.admin_ai_enabled,
      admin_email_crawl_enabled: body.admin_email_crawl_enabled,
    });
    return { ok: true };
  }

  @Get('activity')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  activity() {
    return this.platformAdminService.getActivityStats();
  }

  @Get('companies/:id/detail')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  companyDetail(@Param('id') id: string) {
    return this.platformAdminService.getCompanyDetail(id);
  }

  @Patch('companies/:companyId/users/:userId/password')
  @UseGuards(PlatformAdminGuard)
  async setCompanyUserPassword(
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @Body() body: { password?: string },
  ) {
    const password = body.password?.trim() ?? '';
    if (!password) {
      throw new BadRequestException('password is required (min 8 characters)');
    }
    return this.platformAdminService.setCompanyUserPassword(companyId, userId, password);
  }

  @Patch('companies/:companyId/employees/:employeeId/portal-password')
  @UseGuards(PlatformAdminGuard)
  async setCompanyEmployeePortalPassword(
    @Param('companyId') companyId: string,
    @Param('employeeId') employeeId: string,
    @Body() body: { password?: string },
  ) {
    const password = body.password?.trim() ?? '';
    if (!password) {
      throw new BadRequestException('password is required (min 8 characters)');
    }
    return this.platformAdminService.setCompanyEmployeePortalPassword(companyId, employeeId, password);
  }

  @Delete('companies/:id')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  async deleteCompany(@Param('id') id: string) {
    await this.platformAdminService.deleteCompany(id);
    return { ok: true };
  }

  @Post('reset-api-quota')
  @UseGuards(PlatformAdminGuard)
  async resetApiQuota() {
    await this.settingsService.resetApiQuotaExhausted();
    return { ok: true, message: 'API quota flag cleared — sync and alerts will resume on the next cycle.' };
  }

  @Get('api-quota-status')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  async getApiQuotaStatus() {
    const settings = await this.settingsService.getAll();
    return {
      api_quota_exhausted: settings.api_quota_exhausted,
      api_quota_exhausted_at: settings.api_quota_exhausted_at,
    };
  }

  @Get('billing')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  billing(@Req() req: Request) {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    return this.companyBillingService.getBillingOverview(month);
  }

  @Get('billing/:companyId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  companyBilling(@Param('companyId') companyId: string, @Req() req: Request) {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    return this.companyBillingService.getCompanyBilling(companyId, month);
  }
}
