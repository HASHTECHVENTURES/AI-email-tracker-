'use client';

import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { PageHeader } from '@/components/admin/ui';
import { ChangePasswordCard } from '@/components/ChangePasswordCard';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';

export default function AdminAccountPage() {
  const { allowed, loading, me, signOut, token } = usePlatformAdmin('/account');

  if (loading) {
    return (
      <AdminShell title="Account" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false) return null;

  return (
    <AdminShell title="Account" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <PageHeader
        title="Your account"
        description="Manage your platform admin sign-in password."
      />
      {token ? <ChangePasswordCard accessToken={token} /> : null}
    </AdminShell>
  );
}
