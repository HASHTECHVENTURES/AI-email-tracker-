import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
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
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const protectedPaths = [
    '/dashboard',
    '/departments',
    '/employees',
    '/ai-reports',
    '/email-archive',
    '/messages',
    '/manager-messages',
  ];
  const isProtected = protectedPaths.some((p) => request.nextUrl.pathname.startsWith(p));
  if (!user && isProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/auth';
    redirectUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/departments/:path*',
    '/employees/:path*',
    '/ai-reports/:path*',
    '/email-archive',
    '/email-archive/:path*',
    '/messages/:path*',
    '/manager-messages',
    '/manager-messages/:path*',
  ],
};
