import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { EmployeeRole } from './types';

export interface RequestContext {
  companyId: string;
  role: EmployeeRole;
  employeeId?: string;
  departmentId?: string;
}

function readManagerActiveDepartmentHeader(req: Request): string | undefined {
  const raw = req.headers['x-manager-department-id'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Tenant context from the authenticated `public.users` row only.
 * Never use x-company-id / x-role headers for authorization.
 *
 * **HEAD:** optional `x-manager-department-id` selects which managed team this request applies to
 * (must be in `user.managedDepartmentIds`). If omitted, uses profile default (`user.departmentId`).
 */
export function getRequestContext(req: Request): RequestContext {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedException('Authenticated user profile is required');
  }

  if (user.role === 'PLATFORM_ADMIN') {
    throw new ForbiddenException(
      'Platform operators manage tenants at /admin, not inside a company workspace.',
    );
  }

  let departmentId = user.departmentId ?? undefined;

  if (user.role === 'HEAD') {
    const managed =
      user.managedDepartmentIds && user.managedDepartmentIds.length > 0
        ? user.managedDepartmentIds
        : user.departmentId
          ? [user.departmentId]
          : [];
    const requested = readManagerActiveDepartmentHeader(req);
    if (managed.length > 0) {
      if (requested && managed.includes(requested)) {
        departmentId = requested;
      } else {
        departmentId =
          user.departmentId && managed.includes(user.departmentId)
            ? user.departmentId
            : managed[0];
      }
    } else {
      departmentId = undefined;
    }
  }

  return {
    companyId: user.companyId,
    role: user.role,
    employeeId: user.role === 'EMPLOYEE' ? user.linkedEmployeeId ?? undefined : undefined,
    departmentId,
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
