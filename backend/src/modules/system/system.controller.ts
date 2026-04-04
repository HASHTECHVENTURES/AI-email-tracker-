import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { SettingsService } from '../settings/settings.service';
import { SystemDiagnosticsService } from './system-diagnostics.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly systemDiagnosticsService: SystemDiagnosticsService,
  ) {}

  @Get('status')
  async status(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.settingsService.getSystemStatus(ctx.companyId);
  }

  /** CEO / department HEAD: why mail may not show on dashboards (settings, OAuth, crawl, tracking window, counts). */
  @Get('diagnostics')
  async diagnostics(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.systemDiagnosticsService.run(ctx);
  }
}
