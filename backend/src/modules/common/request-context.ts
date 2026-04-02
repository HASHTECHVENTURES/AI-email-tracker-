import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { EmployeeRole } from './types';

export interface RequestContext {
  companyId: string;
  role: EmployeeRole;
  employeeId?: string;
  departmentId?: string;
}

function readHeader(req: Request, key: string): string | undefined {
  const value = req.headers[key.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function getRequestContext(req: Request): RequestContext {
  const headerCompany = readHeader(req, 'x-company-id');
  const fallbackCompany = process.env.DEFAULT_COMPANY_ID?.trim();
  const companyId = headerCompany ?? fallbackCompany;
  if (!companyId) {
    throw new BadRequestException(
      'Missing x-company-id header (or set DEFAULT_COMPANY_ID in backend .env for local demo)',
    );
  }

  const role = (readHeader(req, 'x-role') ?? 'CEO').toUpperCase() as EmployeeRole;
  if (!['CEO', 'HEAD', 'EMPLOYEE'].includes(role)) {
    throw new BadRequestException('Invalid x-role header');
  }

  const employeeId = readHeader(req, 'x-employee-id');
  const departmentId = readHeader(req, 'x-department-id');

  if (role === 'EMPLOYEE' && !employeeId) {
    throw new BadRequestException('x-employee-id is required for EMPLOYEE role');
  }
  if (role === 'HEAD' && !departmentId) {
    throw new BadRequestException('x-department-id is required for HEAD role');
  }

  return { companyId, role, employeeId, departmentId };
}

export function enforceConversationAccess(
  ctx: RequestContext,
  row: { company_id: string; employee_id: string; department_id: string | null },
): void {
  if (row.company_id !== ctx.companyId) {
    throw new ForbiddenException('Conversation does not belong to your company');
  }
  if (ctx.role === 'HEAD' && row.department_id !== ctx.departmentId) {
    throw new ForbiddenException('Conversation is outside your department scope');
  }
  if (ctx.role === 'EMPLOYEE' && row.employee_id !== ctx.employeeId) {
    throw new ForbiddenException('Conversation is outside your employee scope');
  }
}
