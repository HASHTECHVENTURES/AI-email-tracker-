import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isStaleRefreshTokenError } from '@/lib/supabase/session';

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/_vercel') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
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

  const isLogin = pathname === '/login';
  const isProtected = !isLogin;
  const canAccessProtected = hasValidUser || (!clearedStaleSession && hasSupabaseSessionCookie);

  if (!canAccessProtected && isProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.search = '';
    redirectUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ['/', '/login', '/companies/:path*', '/billing', '/activity', '/account'],
};
