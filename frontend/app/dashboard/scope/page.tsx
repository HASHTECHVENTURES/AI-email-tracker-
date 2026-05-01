'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import {
  CeoDashboardScopePanel,
  type CeoScopeOrgEmployee,
  type CeoDeptDirectoryRow,
} from '@/components/CeoDashboardScopePanel';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { TimeGreeting } from '@/components/TimeGreeting';

const SCOPE_KEY = 'ai_et_ceo_dashboard_scope_v1';

export default function DashboardScopePage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut, shellRoleHint } = useAuth();
  const [filterDepartmentIds, setFilterDepartmentIds] = useState<string[]>([]);
  const [ceoEmployeeIds, setCeoEmployeeIds] = useState<string[]>([]);
  const [ceoDeptOptions, setCeoDeptOptions] = useState<CeoDeptDirectoryRow[]>([]);
  const [ceoOrgEmployees, setCeoOrgEmployees] = useState<CeoScopeOrgEmployee[]>([]);
  const [ceoOrgEmployeesLoading, setCeoOrgEmployeesLoading] = useState(false);
  const restoredRef = useRef(false);

  useEffect(() => {
    if (authLoading) return;
    if (!me || !token) {
      router.replace('/auth');
      return;
    }
    if (me.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    if (me.role !== 'CEO') {
      router.replace('/dashboard');
    }
  }, [authLoading, me, router, token]);

  useEffect(() => {
    if (me?.role !== 'CEO' || typeof window === 'undefined' || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = sessionStorage.getItem(SCOPE_KEY);
      if (raw) {
        const j = JSON.parse(raw) as {
          departmentId?: unknown;
          departmentIds?: unknown;
          employeeIds?: unknown;
        };
        let deptIds: string[] = [];
        if (Array.isArray(j.departmentIds)) {
          deptIds = [
            ...new Set(j.departmentIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)),
          ];
        } else if (typeof j.departmentId === 'string' && j.departmentId.trim()) {
          deptIds = [j.departmentId.trim()];
        }
        let empIds: string[] = [];
        if (Array.isArray(j.employeeIds)) {
          empIds = [
            ...new Set(j.employeeIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)),
          ];
        }
        setFilterDepartmentIds(deptIds);
        setCeoEmployeeIds(empIds);
      }
    } catch {
      /* ignore */
    }
  }, [me?.role]);

  useEffect(() => {
    if (!token || me?.role !== 'CEO') {
      setCeoDeptOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await apiFetch('/departments', token);
      if (!r.ok || cancelled) return;
      const rows = (await r.json()) as CeoDeptDirectoryRow[];
      setCeoDeptOptions(Array.isArray(rows) ? rows : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, me?.role]);

  useEffect(() => {
    if (!token || me?.role !== 'CEO') {
      setCeoOrgEmployees([]);
      setCeoOrgEmployeesLoading(false);
      return;
    }
    let cancelled = false;
    setCeoOrgEmployeesLoading(true);
    void (async () => {
      const r = await apiFetch('/employees', token);
      if (!r.ok || cancelled) {
        if (!cancelled) setCeoOrgEmployeesLoading(false);
        return;
      }
      const rows = (await r.json()) as CeoScopeOrgEmployee[];
      if (!cancelled) {
        setCeoOrgEmployees(Array.isArray(rows) ? rows : []);
        setCeoOrgEmployeesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, me?.role]);

  const refetchScopeCatalog = useCallback(async () => {
    if (!token || me?.role !== 'CEO') return;
    const [r, empR] = await Promise.all([apiFetch('/departments', token), apiFetch('/employees', token)]);
    if (r.ok) {
      const rows = (await r.json()) as CeoDeptDirectoryRow[];
      setCeoDeptOptions(Array.isArray(rows) ? rows : []);
    }
    setCeoOrgEmployeesLoading(true);
    if (!empR.ok) {
      setCeoOrgEmployeesLoading(false);
      return;
    }
    const empRows = (await empR.json()) as CeoScopeOrgEmployee[];
    setCeoOrgEmployees(Array.isArray(empRows) ? empRows : []);
    setCeoOrgEmployeesLoading(false);
  }, [token, me?.role]);

  useRefetchOnFocus(() => void refetchScopeCatalog(), Boolean(token && me?.role === 'CEO' && !authLoading));

  useEffect(() => {
    if (me?.role !== 'CEO' || ceoDeptOptions.length === 0) return;
    const allowed = new Set(ceoDeptOptions.map((d) => d.id));
    setFilterDepartmentIds((prev) => {
      const next = prev.filter((id) => allowed.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [ceoDeptOptions, me?.role]);

  const applyCeoScope = useCallback((departmentIds: string[], employeeIds: string[]) => {
    const nextDepts = [...new Set(departmentIds)];
    const nextEmps = [...new Set(employeeIds)];
    setFilterDepartmentIds(nextDepts);
    setCeoEmployeeIds(nextEmps);
    try {
      sessionStorage.setItem(
        SCOPE_KEY,
        JSON.stringify({
          departmentIds: nextDepts,
          employeeIds: nextEmps,
        }),
      );
    } catch {
      /* ignore */
    }
    router.push('/dashboard');
  }, [router]);

  const shellRoleForLoading = me?.role ?? shellRoleHint ?? 'EMPLOYEE';

  if (!me || authLoading) {
    return (
      <AppShell
        role={shellRoleForLoading}
        title="Dashboard scope"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  if (me.role !== 'CEO') {
    return null;
  }

  const titleEyebrow = <TimeGreeting fullName={me.full_name} email={me.email} />;

  return (
    <AppShell
      role="CEO"
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      titleEyebrow={titleEyebrow}
      title="Command center scope"
      subtitle="Pick managers (whole team) and/or employees (single mailboxes) to focus charts and lists on the dashboard."
      onSignOut={() => void ctxSignOut()}
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard"
          className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-brand-200 hover:bg-slate-50"
        >
          ← Back to command center
        </Link>
      </div>

      <div className="rounded-2xl border border-slate-200/60 bg-surface-card p-6 shadow-card sm:p-8">
        <CeoDashboardScopePanel
          embedded
          panelOpen
          departmentOptions={ceoDeptOptions}
          orgEmployees={ceoOrgEmployees}
          selectedDepartmentIds={filterDepartmentIds}
          selectedEmployeeIds={ceoEmployeeIds}
          onApply={applyCeoScope}
          loadingEmployees={ceoOrgEmployeesLoading}
        />
      </div>
    </AppShell>
  );
}
