import { BadRequestException, Body, Controller, ForbiddenException, Get, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getAll(@Req() req: Request) {
    getRequestContext(req);
    return this.settingsService.getAll();
  }

  @Get('runtime')
  async getRuntime(@Req() req: Request) {
    getRequestContext(req);
    return this.settingsService.getRuntimeStatus();
  }

  @Put()
  async update(@Req() req: Request, @Body() body: { key: string; value: string }) {
    getRequestContext(req);
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
