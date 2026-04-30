import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Patch,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { DepartmentsService } from './departments.service';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Post()
  async create(@Req() req: Request, @Body() body: { name?: string }) {
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEO can create departments');
    }
    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    try {
      const row = await this.departmentsService.create(ctx.companyId, name);
      return row;
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === '23505') {
        throw new BadRequestException('A department with this name already exists');
      }
      throw err;
    }
  }

  @Get()
  async list(@Req() req: Request) {
    const ctx = getRequestContext(req);
    if (ctx.role === 'EMPLOYEE') {
      return [];
    }
    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId) {
        return [];
      }
      const d = await this.departmentsService.getById(ctx.companyId, ctx.departmentId);
      if (!d) return [];
      const count = await this.departmentsService.countEmployees(ctx.companyId, d.id);
      const manager = await this.departmentsService.getDepartmentManager(ctx.companyId, d.id);
      return [{ ...d, employee_count: count, manager }];
    }
    return this.departmentsService.listWithEmployeeCounts(ctx.companyId);
  }

  @Delete(':id')
  async delete(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEO can delete departments');
    }
    await this.departmentsService.deleteWithCleanup(ctx.companyId, id);
    return { status: 'ok' };
  }

  @Patch(':id')
  async rename(@Req() req: Request, @Param('id') id: string, @Body() body: { name?: string }) {
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEO can rename departments');
    }
    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const dept = await this.departmentsService.getById(ctx.companyId, id);
    if (!dept) {
      throw new BadRequestException('Department not found');
    }
    try {
      const row = await this.departmentsService.rename(ctx.companyId, id, name);
      return row;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === '23505') {
        throw new BadRequestException('A department with this name already exists');
      }
      throw err;
    }
  }

  @Post(':id/assign-manager')
  async assignManager(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { email?: string; full_name?: string; password?: string },
  ) {
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEO can assign managers');
    }
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('email is required');
    }
    const dept = await this.departmentsService.getById(ctx.companyId, id);
    if (!dept) {
      throw new BadRequestException('Department not found');
    }
    try {
      const user = await this.departmentsService.assignManager(ctx.companyId, id, email, {
        fullName: body.full_name,
        password: body.password,
      });
      return { ok: true, user };
    } catch (err: unknown) {
      const e = err as { message?: string };
      if (e.message === 'PASSWORD_REQUIRED') {
        throw new BadRequestException(
          'User not found in your company. Provide a password (min 8 chars) to create manager account.',
        );
      }
      if (e.message === 'AUTH_USER_CREATE_FAILED') {
        throw new BadRequestException('Could not create manager auth account for this email');
      }
      if (e.message === 'MANAGER_PROFILE_CREATE_FAILED') {
        throw new BadRequestException('Could not create manager profile in this company');
      }
      throw err;
    }
  }

  @Post(':id/manager-password')
  async resetManagerPassword(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEO can reset manager password');
    }
    const password = body.password?.trim() ?? '';
    if (!password) {
      throw new BadRequestException('password is required');
    }
    const dept = await this.departmentsService.getById(ctx.companyId, id);
    if (!dept) {
      throw new BadRequestException('Department not found');
    }
    try {
      await this.departmentsService.resetManagerPassword(ctx.companyId, id, password);
      return { ok: true };
    } catch (err: unknown) {
      const e = err as { message?: string };
      if (e.message === 'PASSWORD_TOO_SHORT') {
        throw new BadRequestException('Password must be at least 8 characters');
      }
      if (e.message === 'MANAGER_NOT_FOUND') {
        throw new BadRequestException('No manager assigned to this department');
      }
      if (e.message === 'PASSWORD_RESET_FAILED') {
        throw new BadRequestException('Could not reset manager password');
      }
      throw err;
    }
  }
}
