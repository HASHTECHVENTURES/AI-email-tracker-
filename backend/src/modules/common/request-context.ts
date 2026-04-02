import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { EmployeeRole } from './types';

export interface RequestContext {
  companyId: string;
  role: EmployeeRole;
  employeeId?: string;
  departmentId?: string;
}

/**
 * Tenant context from the authenticated `public.users` row only.
 * Never use x-company-id / x-role headers for authorization.
 */
export function getRequestContext(req: Request): RequestContext {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedException('Authenticated user profile is required');
  }

  return {
    companyId: user.companyId,
    role: user.role,
    employeeId: user.role === 'EMPLOYEE' ? user.linkedEmployeeId ?? undefined : undefined,
    departmentId: user.departmentId ?? undefined,
  };
}

export function enforceConversationAccess(
  ctx: RequestContext,
  row: { company_id: string; employee_id: string; department_id: string | null },
): void {
  if (row.company_id !== ctx.companyId) {
    throw new ForbiddenException('Conversation does not belong to your company');
  }
  if (ctx.role === 'HEAD' && ctx.departmentId && row.department_id !== ctx.departmentId) {
    throw new ForbiddenException('Conversation is outside your department scope');
  }
  if (ctx.role === 'EMPLOYEE' && ctx.employeeId && row.employee_id !== ctx.employeeId) {
    throw new ForbiddenException('Conversation is outside your employee scope');
  }
}
