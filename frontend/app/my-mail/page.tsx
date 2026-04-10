'use client';

import { Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';

/**
 * Legacy route: manager inbox now lives on `/my-email` (same Live + Historical experience as CEO).
 */
function MyMailRedirectInner() {
  const router = useRouter();
  const { me, loading: authLoading, signOut: ctxSignOut } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!me) {
      router.replace('/auth');
      return;
    }
    if (me.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    if (isDepartmentManagerRole(me.role)) {
      router.replace('/my-email');
      return;
    }
    router.replace('/dashboard');
  }, [authLoading, me, router]);

  return (
    <AppShell
      role={me?.role ?? 'HEAD'}
      title="My mail"
      subtitle="Opening My Email…"
      onSignOut={() => void ctxSignOut()}
    >
      <PageSkeleton />
    </AppShell>
  );
}

export default function ManagerMyMailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <PageSkeleton />
        </div>
      }
    >
      <MyMailRedirectInner />
    </Suspense>
  );
}
