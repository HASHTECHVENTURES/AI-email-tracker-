import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

/**
 * Inlined so it still applies if `/_next/static/css/*.css` fails to load (stale tab,
 * corrupt .next, chunk 404). globals.css alone is in that same bundle and disappears
 * with it — this keeps AppShell layout from double headers / smashed nav links.
 */
const criticalAppShellCss = `
.app-shell-body { min-height: 100vh; box-sizing: border-box; }
@media (max-width: 1023px) {
  .app-shell-sidebar { display: none !important; }
}
@media (min-width: 1024px) {
  .app-shell-mobile-nav { display: none !important; }
  .app-shell-body {
    display: flex !important;
    flex-direction: row;
    align-items: stretch;
    max-width: 1440px;
    margin-left: auto;
    margin-right: auto;
  }
  .app-shell-sidebar {
    display: flex !important;
    flex-direction: column;
    width: 16rem;
    flex-shrink: 0;
    min-height: 100vh;
    box-sizing: border-box;
    padding: 1.5rem 1rem;
    background-color: #ffffff;
  }
  .app-shell-main-column {
    flex: 1 1 0%;
    min-width: 0;
    display: flex !important;
    flex-direction: column;
  }
}
.app-shell-mobile-nav nav.app-shell-mobile-nav-links,
nav.app-shell-mobile-nav-links {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 0.375rem !important;
  align-items: center;
}
.app-shell-mobile-nav-links a {
  display: inline-flex !important;
  align-items: center;
  text-decoration: none;
}
.app-shell-sidebar nav a {
  display: block;
  text-decoration: none;
}
.app-shell-page-header {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
@media (min-width: 640px) {
  .app-shell-page-header {
    flex-direction: row;
    align-items: flex-start;
    justify-content: space-between;
  }
}
/* If Tailwind/global CSS chunks 404, keep text readable (shell layout rules above still apply). */
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    sans-serif;
  font-size: 16px;
  line-height: 1.5;
}
a {
  color: #4f46e5;
}
button,
input,
select {
  font: inherit;
}
button {
  cursor: pointer;
}
`;

export const metadata: Metadata = {
  title: 'Follow-ups',
  description: 'Track conversations and follow-ups across your team.',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f8fafc',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: criticalAppShellCss }} />
      </head>
      <body className={inter.className} suppressHydrationWarning>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
