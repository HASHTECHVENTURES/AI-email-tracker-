const REQUIRED_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SUPABASE_URL',
  'INTERNAL_API_KEY',
  'ENCRYPTION_KEY',
] as const;

const REQUIRE_ONE_OF: Array<readonly string[]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'],
];

function hasGoogleOAuthRedirect(): boolean {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit && explicit !== 'local-dev-placeholder') return true;
  return Boolean(process.env.RAILWAY_PUBLIC_DOMAIN?.trim());
}

/** Google AI / Gemini — same sources as GET /settings `gemini_api_key_configured`. */
export function getGeminiApiKeyFromEnv(): string {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    ''
  );
}

export function isGeminiEnvConfigured(): boolean {
  return Boolean(getGeminiApiKeyFromEnv());
}

export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (!hasGoogleOAuthRedirect()) {
    throw new Error(
      'Missing Google OAuth redirect: set GOOGLE_REDIRECT_URI or RAILWAY_PUBLIC_DOMAIN (Railway)',
    );
  }

  for (const set of REQUIRE_ONE_OF) {
    const hasAny = set.some((key) => Boolean(process.env[key]?.trim()));
    if (!hasAny) {
      throw new Error(`Missing required environment variable set: one of [${set.join(', ')}]`);
    }
  }
}
