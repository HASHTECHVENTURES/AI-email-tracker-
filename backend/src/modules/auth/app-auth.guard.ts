import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Inject } from '@nestjs/common';
import { Request } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { ALLOW_PENDING_ONBOARDING } from '../common/allow-pending-onboarding.decorator';
import { IS_PUBLIC_ROUTE } from '../common/public-route.decorator';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { SaasAuthService } from './saas-auth.service';

function readBearer(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader?.toLowerCase().startsWith('bearer ')) return undefined;
  const token = authHeader.slice(7).trim();
  return token || undefined;
}

function readApiKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (Array.isArray(header)) return header[0]?.trim() || undefined;
  return header?.trim() || undefined;
}

@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly saasAuthService: SaasAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const expectedKey = process.env.INTERNAL_API_KEY?.trim();
    const bearer = readBearer(req);
    const apiKey = readApiKey(req);

    if (expectedKey && (bearer === expectedKey || apiKey === expectedKey)) {
      req.internalApiAuth = true;
      return true;
    }

    if (!bearer) {
      throw new UnauthorizedException('Missing or invalid Authorization bearer token');
    }

    const { data, error } = await this.supabase.auth.getUser(bearer);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const authUser = data.user;
    const email = authUser.email ?? '';
    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_ONBOARDING, [
      context.getHandler(),
      context.getClass(),
    ]);

    const profile = await this.saasAuthService.findProfileByAuthId(authUser.id);
    if (profile) {
      req.user = profile;
      return true;
    }

    if (allowPending) {
      req.jwtSub = authUser.id;
      req.jwtEmail = email;
      return true;
    }

    throw new ForbiddenException({
      code: 'ONBOARDING_REQUIRED',
      message: 'Complete signup to create your company and profile.',
    });
  }
}
