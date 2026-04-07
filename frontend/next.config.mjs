/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === 'development';

/**
 * Prevent browsers from caching **HTML documents** for app routes. Stale HTML
 * points at old `/_next/static/chunks/*.js` and `layout-*.css` hashes after
 * `next dev` restarts or `next build` — causing 404s and an unstyled / stuck UI.
 * Dev: strong no-store. Prod (`next start`): no-cache so revalidated after deploy.
 * (Does not apply to `/_next/static/*` assets; those keep normal immutable caching.)
 */
const devDocumentNoStore = [
  '/',
  '/auth',
  '/auth/:path*',
  '/admin',
  '/admin/:path*',
  '/dashboard',
  '/dashboard/:path*',
  '/departments/:path*',
  '/employees',
  '/employees/:path*',
  '/ai-reports/:path*',
  '/settings',
  '/settings/:path*',
  '/messages/:path*',
  '/manager-messages',
  '/manager-messages/:path*',
  '/my-email',
  '/my-email/:path*',
  '/my-mail',
  '/my-mail/:path*',
  '/email-archive',
  '/email-archive/:path*',
];

const nextConfig = {
  reactStrictMode: true,
  /**
   * Permanent fix for recurring dev static 404s:
   * keep dev and production build artifacts in separate folders.
   * (`next dev` + `next build` in same repo can corrupt shared `.next` state.)
   */
  distDir: isDev ? '.next-dev' : '.next',

  /**
   * Do not set `config.cache = false` in dev: it forces full rebuilds and can race the dev server,
   * producing HTML that references `/_next/static/...` chunks before they exist (404 + stuck UI).
   * Default Webpack filesystem cache is the stable choice for `next dev`.
   */

  /** Browsers often request /favicon.ico by default */
  async redirects() {
    return [
      {
        source: '/favicon.ico',
        destination: '/favicon.svg',
        permanent: false,
      },
    ];
  },

  async headers() {
    return devDocumentNoStore.map((source) => ({
      source,
      headers: [
        {
          key: 'Cache-Control',
          value: isDev
            ? 'no-store, must-revalidate, max-age=0'
            : 'no-cache, must-revalidate',
        },
      ],
    }));
  },

};

export default nextConfig;
