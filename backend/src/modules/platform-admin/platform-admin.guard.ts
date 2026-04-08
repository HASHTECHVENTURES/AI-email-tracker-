import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

const BOOTSTRAP_PLATFORM_ADMIN_EMAIL = 'email@gmail.com';

function collectPlatformAdminEmails(): Set<string> {
  const emails = new Set<string>();
  const fromList = process.env.PLATFORM_ADMIN_EMAILS?.trim();
  if (fromList) {
    fromList
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .forEach((e) => emails.add(e));
  }
  const bootstrap = (process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL || BOOTSTRAP_PLATFORM_ADMIN_EMAIL)
    .trim()
    .toLowerCase();
  if (bootstrap) emails.add(bootstrap);
  return emails;
}

export function isPlatformAdminEmail(email: string | undefined | null): boolean {
  if (!email?.trim()) return false;
  const allowed = collectPlatformAdminEmails();
  if (allowed.size === 0) return false;
  return allowed.has(email.trim().toLowerCase());
}

export function isPlatformAdminUser(user: { email?: string | null; role?: string | null } | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'PLATFORM_ADMIN') return true;
  return isPlatformAdminEmail(user.email);
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!isPlatformAdminUser(user)) {
      throw new ForbiddenException('Platform admin access required');
    }
    return true;
  }
}
