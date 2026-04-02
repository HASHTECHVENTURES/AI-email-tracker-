import { Body, Controller, Get, Put, Req } from '@nestjs/common';
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
}
