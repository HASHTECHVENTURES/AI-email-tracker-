/**
 * Google OAuth env values with trim — stray whitespace in Railway/.env breaks
 * redirect_uri matching (Google returns 400 invalid_request / redirect_uri_mismatch).
 */
export function getGoogleOAuthCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() ?? '',
  };
}
