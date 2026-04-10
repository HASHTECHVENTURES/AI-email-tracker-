import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** Copy Set-Cookie headers from session refresh onto another response (e.g. auth redirect). */
function copyCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach((c) => {
    to.cookies.set(c.name, c.value, c);
  });
}

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

    if (pathname === '/auth' || pathname.startsWith('/auth/')) {
      if (request.nextUrl.searchParams.has('portal')) {
        const url = request.nextUrl.clone();
        url.searchParams.delete('portal');
        return NextResponse.redirect(url);
      }
    }

    let response = NextResponse.next({ request });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      return response;
    }

    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          try {
            cookiesToSet.forEach(({ name, value }) => {
              request.cookies.set(name, value);
            });
          } catch {
            /* Next.js may treat request cookies as read-only; response cookies are enough for the browser */
          }
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    let user: { id: string } | null = null;
    try {
      const { data } = await supabase.auth.getUser();
      user = data.user;
    } catch {
      user = null;
    }

    const protectedPaths = [
      '/admin',
      '/dashboard',
      '/conversation',
      '/departments',
      '/employees',
      '/ai-reports',
      '/settings',
      '/messages',
      '/manager-messages',
      '/my-email',
      '/my-mail',
    ];
    const isAdminLogin = pathname === '/admin/login';
    const isProtected = !isAdminLogin && protectedPaths.some((p) => pathname.startsWith(p));
    if (!user && isProtected) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = pathname.startsWith('/admin') ? '/admin/login' : '/auth';
      redirectUrl.searchParams.set('next', request.nextUrl.pathname);
      const redirectResponse = NextResponse.redirect(redirectUrl);
      copyCookies(response, redirectResponse);
      return redirectResponse;
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
  ],
};
