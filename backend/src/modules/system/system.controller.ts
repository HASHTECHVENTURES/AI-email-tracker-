import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { SettingsService } from '../settings/settings.service';
import { SystemDiagnosticsService } from './system-diagnostics.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly systemDiagnosticsService: SystemDiagnosticsService,
    private readonly companyPolicyService: CompanyPolicyService,
  ) {}

  @Get('status')
  async status(@Req() req: Request) {
    const ctx = getRequestContext(req);
    const [status, flags] = await Promise.all([
      this.settingsService.getSystemStatus(ctx.companyId),
      this.companyPolicyService.getFlags(ctx.companyId),
    ]);
    return {
      ...status,
      ai_status: status.ai_status && flags.admin_ai_enabled,
      ai_for_managers_enabled: status.ai_for_managers_enabled && flags.admin_ai_enabled,
      email_crawl_enabled: status.email_crawl_enabled && flags.admin_email_crawl_enabled,
      seconds_until_next_ingestion: flags.admin_email_crawl_enabled ? status.seconds_until_next_ingestion : null,
      seconds_until_next_report: flags.admin_ai_enabled ? status.seconds_until_next_report : null,
    };
  }

  /** CEO / department HEAD: why mail may not show on dashboards (settings, OAuth, crawl, tracking window, counts). */
  @Get('diagnostics')
  async diagnostics(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.systemDiagnosticsService.run(ctx);
  }
}
