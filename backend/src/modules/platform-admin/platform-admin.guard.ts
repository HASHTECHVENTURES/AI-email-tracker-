import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

export function isPlatformAdminEmail(email: string | undefined | null): boolean {
  if (!email?.trim()) return false;
  const raw = process.env.PLATFORM_ADMIN_EMAILS?.trim();
  if (!raw) return false;
  const allowed = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(email.trim().toLowerCase());
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user?.email) {
      throw new ForbiddenException('Platform admin access required');
    }
    if (!isPlatformAdminEmail(user.email)) {
      throw new ForbiddenException('Platform admin access required');
    }
    return true;
  }
}
