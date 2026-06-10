import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isStaleRefreshTokenError } from '@/lib/supabase/session';

export async function middleware(request: NextRequest) {
  try {
    const pathname = request.nextUrl.pathname;

    // Framework & static assets — skip Supabase session work (defense in depth).
    if (
      pathname.startsWith('/_next') ||
      pathname.startsWith('/_vercel') ||
      pathname.startsWith('/favicon')
    ) {
      return NextResponse.next();
    }

    // Remove legacy `?__reload=` from URLs (old client recovery script); stable URLs avoid stale HTML confusion.
    if (request.nextUrl.searchParams.has('__reload')) {
      const clean = request.nextUrl.clone();
      clean.searchParams.delete('__reload');
      return NextResponse.redirect(clean);
    }

    if (pathname === '/portal' || pathname.startsWith('/portal/')) {
      const url = request.nextUrl.clone();
      url.pathname = '/auth';
      url.search = '';
      return NextResponse.redirect(url);
    }

    let response = NextResponse.next({ request });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

    const hasSupabaseSessionCookie = request.cookies.getAll().some((cookie) => {
      if (!cookie.name.startsWith('sb-')) return false;
      return cookie.name.endsWith('-auth-token') || cookie.name.includes('-auth-token.');
    });

    let hasValidUser = false;
    let clearedStaleSession = false;
    if (supabaseUrl && supabaseKey && hasSupabaseSessionCookie) {
      const supabase = createServerClient(supabaseUrl, supabaseKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
            cookiesToSet.forEach(({ name, value }) => {
              request.cookies.set(name, value);
            });
            response = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });
          },
        },
      });

      const { data, error } = await supabase.auth.getUser();
      if (error) {
        if (isStaleRefreshTokenError(error)) {
          await supabase.auth.signOut();
          clearedStaleSession = true;
        }
      } else if (data.user) {
        hasValidUser = true;
      }
    }

    if (pathname === '/auth' || pathname.startsWith('/auth/')) {
      if (request.nextUrl.searchParams.has('portal')) {
        const url = request.nextUrl.clone();
        url.searchParams.delete('portal');
        return NextResponse.redirect(url);
      }
      return response;
    }

    const protectedPaths = [
      '/admin',
      '/dashboard',
      '/conversation',
      '/departments',
      '/employees',
      '/settings',
      '/messages',
      '/manager-messages',
      '/my-email',
      '/my-mail',
      '/team-mail-sync',
    ];
    const isAdminLogin = pathname === '/admin/login';
    const isProtected = !isAdminLogin && protectedPaths.some((p) => pathname.startsWith(p));

    const canAccessProtected =
      hasValidUser || (!clearedStaleSession && hasSupabaseSessionCookie);

    if (!canAccessProtected && isProtected) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = pathname.startsWith('/admin') ? '/admin/login' : '/auth';
      // Do not clone the full query string (e.g. Gmail OAuth adds connected=, employee_id=).
      // Only forward a safe subset so /auth stays predictable and we can re-attach success after login.
      redirectUrl.search = '';
      redirectUrl.searchParams.set('next', request.nextUrl.pathname);
      const gmailConnected = request.nextUrl.searchParams.get('connected');
      if (gmailConnected === '1') {
        redirectUrl.searchParams.set('connected', '1');
      }
      return NextResponse.redirect(redirectUrl);
    }

    return response;
  } catch (e) {
    console.error('[middleware]', e);
    return NextResponse.next({ request });
  }
}

export const config = {
  matcher: [
    '/auth',
    '/auth/:path*',
    '/portal',
    '/portal/:path*',
    '/admin',
    '/admin/:path*',
    '/dashboard',
    '/dashboard/:path*',
    '/conversation/:path*',
    '/departments/:path*',
    '/employees/:path*',
    '/settings',
    '/settings/:path*',
    '/messages/:path*',
    '/manager-messages',
    '/manager-messages/:path*',
    '/my-email',
    '/my-email/:path*',
    '/my-mail',
    '/my-mail/:path*',
    '/team-mail-sync',
    '/team-mail-sync/:path*',
  ],
};
