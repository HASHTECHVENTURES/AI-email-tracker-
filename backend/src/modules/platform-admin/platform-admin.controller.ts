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
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformAdminGuard, isPlatformAdminUser } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

@Controller('platform-admin')
export class PlatformAdminController {
  constructor(private readonly platformAdminService: PlatformAdminService) {}

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

  @Get('companies/:id/detail')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  companyDetail(@Param('id') id: string) {
    return this.platformAdminService.getCompanyDetail(id);
  }

  @Delete('companies/:id')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard)
  async deleteCompany(@Param('id') id: string) {
    await this.platformAdminService.deleteCompany(id);
    return { ok: true };
  }
}
