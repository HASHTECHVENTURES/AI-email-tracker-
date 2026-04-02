import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_ONBOARDING = 'allowPendingOnboarding';

/** Valid Supabase JWT is enough; `public.users` row may be missing (onboarding). */
export const AllowPendingOnboarding = () => SetMetadata(ALLOW_PENDING_ONBOARDING, true);
