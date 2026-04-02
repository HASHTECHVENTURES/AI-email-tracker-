import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { OauthTokenService } from './oauth-token.service';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
  providers: [supabaseProvider, OauthTokenService],
  exports: [OauthTokenService, supabaseProvider],
})
export class AuthModule {}
