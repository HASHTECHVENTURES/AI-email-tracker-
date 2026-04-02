import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { SettingsService } from '../settings/settings.service';

@Controller('system')
export class SystemController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('status')
  async status(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.settingsService.getSystemStatus(ctx.companyId);
  }
}
