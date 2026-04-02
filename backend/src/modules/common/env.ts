const REQUIRED_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'SUPABASE_URL',
  'INTERNAL_API_KEY',
  'ENCRYPTION_KEY',
] as const;

const REQUIRE_ONE_OF: Array<readonly string[]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'],
];

export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  for (const set of REQUIRE_ONE_OF) {
    const hasAny = set.some((key) => Boolean(process.env[key]?.trim()));
    if (!hasAny) {
      throw new Error(`Missing required environment variable set: one of [${set.join(', ')}]`);
    }
  }
}
