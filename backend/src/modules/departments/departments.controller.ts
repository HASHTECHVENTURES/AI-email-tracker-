import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { DepartmentsService } from './departments.service';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Post()
  async create(@Req() req: Request, @Body() body: { name: string }) {
    const ctx = getRequestContext(req);
    return this.departmentsService.create(ctx.companyId, body.name.trim());
  }

  @Get()
  async list(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.departmentsService.list(ctx.companyId);
  }

  @Delete(':id')
  async delete(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    await this.departmentsService.delete(ctx.companyId, id);
    return { status: 'ok' };
  }
}
