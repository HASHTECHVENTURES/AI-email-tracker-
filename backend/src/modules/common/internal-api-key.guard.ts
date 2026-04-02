import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_ROUTE } from './public-route.decorator';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const expectedKey = process.env.INTERNAL_API_KEY?.trim();
    if (!expectedKey) {
      throw new UnauthorizedException('INTERNAL_API_KEY is not configured');
    }

    const headerKey = req.headers['x-api-key'];
    const keyFromHeader = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : undefined;

    const supplied = keyFromHeader?.trim() ?? bearerToken;
    if (!supplied || supplied !== expectedKey) {
      throw new UnauthorizedException('Invalid internal API key');
    }

    return true;
  }
}
