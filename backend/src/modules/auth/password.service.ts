import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  assertMinPassword(password: string): string {
    const trimmed = password.trim();
    if (trimmed.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    return trimmed;
  }

  assertServiceRoleConfigured(): void {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      throw new BadRequestException(
        'SUPABASE_SERVICE_ROLE_KEY is required for password operations on the server.',
      );
    }
  }

  async verifyCurrentPassword(email: string, currentPassword: string): Promise<void> {
    const url = process.env.SUPABASE_URL?.trim();
    const anon =
      process.env.SUPABASE_ANON_KEY?.trim() ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    if (!url || !anon) {
      throw new BadRequestException('Server auth configuration is incomplete.');
    }

    const probe = createClient(url, anon, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await probe.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: currentPassword,
    });
    if (error) {
      throw new UnauthorizedException('Current password is incorrect');
    }
  }

  async updatePasswordByAuthId(authUserId: string, newPassword: string): Promise<void> {
    this.assertServiceRoleConfigured();
    const password = this.assertMinPassword(newPassword);
    const { error } = await this.supabase.auth.admin.updateUserById(authUserId, {
      password,
      email_confirm: true,
    });
    if (error) {
      this.logger.warn(`updatePasswordByAuthId ${authUserId}: ${error.message}`);
      throw new BadRequestException(error.message || 'Could not update password');
    }
  }

  async changeOwnPassword(
    email: string,
    authUserId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const current = currentPassword.trim();
    const next = this.assertMinPassword(newPassword);
    if (!current) {
      throw new BadRequestException('current_password is required');
    }
    if (current === next) {
      throw new BadRequestException('New password must be different from the current password');
    }
    await this.verifyCurrentPassword(email, current);
    await this.updatePasswordByAuthId(authUserId, next);
  }

  async safeDeleteAuthUser(userId: string): Promise<void> {
    const { error } = await this.supabase.auth.admin.deleteUser(userId);
    if (error) {
      this.logger.warn(`safeDeleteAuthUser ${userId}: ${error.message}`);
    }
  }
}
