'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { PasswordInput } from '@/components/PasswordInput';

type Me = {
  id: string;
  role: string;
  company_name?: string | null;
  department_id: string | null;
};

type Department = {
  id: string;
  name: string;
  employee_count?: number;
  manager?: {
    id: string;
    email: string;
    full_name: string | null;
  } | null;
};

type TeamMember = {
  id: string;
  name: string;
  email: string;
  department_id: string;
  department_name: string;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  has_portal_login?: boolean;
};

type RecipientFilter = 'all' | 'manager' | 'employee';
type CxoChatPerson = {
  id: string;
  name: string;
  email: string;
  department_name: string;
  isManager: boolean;
  hasEmployeeMailbox: boolean;
  canMessage: boolean;
};

type SentItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  replies: Array<{ id: string; body: string; created_at: string; from_manager: boolean }>;
};

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dateSeparatorLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, now)) return 'Today';
  if (isSameCalendarDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString();
}

export default function DepartmentsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut, shellRoleHint } = useAuth();
  const [rows, setRows] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [managerName, setManagerName] = useState('');
  const [managerPassword, setManagerPasswordInput] = useState('');
  const [managerDepartmentId, setManagerDepartmentId] = useState('');
  const [passwordDepartmentId, setPasswordDepartmentId] = useState('');
  const [newManagerPassword, setNewManagerPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [teamLoadError, setTeamLoadError] = useState<string | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<TeamMember | null>(null);
  const [portalPassword, setPortalPassword] = useState('');
  const [portalPasswordConfirm, setPortalPasswordConfirm] = useState('');
  const [portalPasswordSaving, setPortalPasswordSaving] = useState(false);
  const [portalPasswordError, setPortalPasswordError] = useState<string | null>(null);
  const [alertTarget, setAlertTarget] = useState<TeamMember | null>(null);
  const [alertMessage, setAlertMessage] = useState('');
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Department | null>(null);
  const [renameDepartmentName, setRenameDepartmentName] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [replaceManagerTarget, setReplaceManagerTarget] = useState<Department | null>(null);
  const [replaceManagerName, setReplaceManagerName] = useState('');
  const [replaceManagerEmail, setReplaceManagerEmail] = useState('');
  const [replaceManagerPassword, setReplaceManagerPassword] = useState('');
  const [replaceManagerSaving, setReplaceManagerSaving] = useState(false);
  const [deletingDeptId, setDeletingDeptId] = useState<string | null>(null);
  const [convertEmail, setConvertEmail] = useState('');
  const [convertDeptId, setConvertDeptId] = useState('');
  const [convertSaving, setConvertSaving] = useState(false);
  const [secondaryRosterEmail, setSecondaryRosterEmail] = useState('');
  const [secondaryRosterDeptId, setSecondaryRosterDeptId] = useState('');
  const [secondaryRosterSaving, setSecondaryRosterSaving] = useState(false);
  const [advancedAction, setAdvancedAction] = useState<'secondary' | 'convert' | 'password' | null>(null);
  const [recipientFilter, setRecipientFilter] = useState<RecipientFilter>('all');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [locHash, setLocHash] = useState('');
  const [ceoSentItems, setCeoSentItems] = useState<SentItem[]>([]);
  const [ceoActiveEmployeeId, setCeoActiveEmployeeId] = useState<string | null>(null);
  const [ceoDraftByEmployeeId, setCeoDraftByEmployeeId] = useState<Record<string, string>>({});
  const [ceoSendingForEmployeeId, setCeoSendingForEmployeeId] = useState<string | null>(null);
  const ceoChatScrollRef = useRef<HTMLDivElement>(null);
  const ceoComposerRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (token: string) => {
    const res = await apiFetch('/departments', token);
    if (!res.ok) {
      if (res.status === 401) {
        await ctxSignOut();
        return;
      }
      setError('Could not load departments');
      return;
    }
    setRows((await res.json()) as Department[]);
  }, [ctxSignOut]);

  const loadTeam = useCallback(async (token: string) => {
    setTeamLoadError(null);
    const res = await apiFetch('/employees', token);
    if (!res.ok) {
      if (res.status === 401) {
        await ctxSignOut();
        return;
      }
      setTeamLoadError('Could not load team list');
      setTeamMembers([]);
      return;
    }
    setTeamMembers((await res.json()) as TeamMember[]);
  }, [ctxSignOut]);

  const loadCeoSentChats = useCallback(async (token: string) => {
    const res = await apiFetch('/team-alerts/sent', token);
    if (!res.ok) {
      if (res.status === 401) {
        await ctxSignOut();
        return;
      }
      setError(await readApiErrorMessage(res, 'Could not load conversations.'));
      setCeoSentItems([]);
      return;
    }
    const body = (await res.json()) as { items?: SentItem[] };
    setCeoSentItems(
      (body.items ?? []).map((x) => ({
        ...x,
        replies: (x.replies ?? []).map((r) => ({ ...r, from_manager: r.from_manager === true })),
      })),
    );
  }, [ctxSignOut]);

  const refetchDepartmentsPage = useCallback(async () => {
    if (!token || !authMe) return;
    await load(token);
    if (isDepartmentManagerRole(authMe.role) || authMe.role === 'CEO') {
      await loadTeam(token);
    }
    if (authMe.role === 'CEO') {
      await loadCeoSentChats(token);
    }
  }, [token, authMe, load, loadTeam, loadCeoSentChats]);

  useRefetchOnFocus(() => void refetchDepartmentsPage(), Boolean(token && authMe && !authLoading));

  useEffect(() => {
    if (authLoading) return;
    if (!authMe || !token) {
      router.replace('/auth');
      return;
    }
    if (authMe.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    if (authMe.role === 'EMPLOYEE') {
      router.replace('/dashboard');
      return;
    }
    (async () => {
      await load(token);
      if (isDepartmentManagerRole(authMe.role) || authMe.role === 'CEO') {
        await loadTeam(token);
      }
      if (authMe.role === 'CEO') {
        await loadCeoSentChats(token);
      }
    })();
  }, [authLoading, authMe, token, router, load, loadTeam, loadCeoSentChats]);

  useEffect(() => {
    if (pathname !== '/departments') return;
    if (typeof window === 'undefined') return;
    const sync = () => setLocHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    if (window.location.hash !== '#team-members') return;
    const el = document.getElementById('team-members');
    if (!el) return;
    const t = window.setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('hashchange', sync);
    };
  }, [pathname]);

  async function reloadTeam() {
    if (token) await loadTeam(token);
  }

  async function deleteDepartment(id: string, name: string, employeeCount: number) {
    if (!token) return;
    const msg =
      employeeCount > 0
        ? `Delete department "${name}"? Its ${employeeCount} employee(s) and any assigned manager will be unassigned.`
        : `Delete department "${name}"?`;
    if (!window.confirm(msg)) return;
    setDeletingDeptId(id);
    setError(null);
    try {
      const res = await apiFetch(`/departments/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j.message as string) || 'Could not delete department');
        return;
      }
      setNotice('Department deleted.');
      await load(token);
    } finally {
      setDeletingDeptId(null);
    }
  }

  async function renameDepartmentFromCard(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !renameTarget) return;
    const nextName = renameDepartmentName.trim();
    if (!nextName) {
      setError('Department name is required');
      return;
    }
    setRenameSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/departments/${encodeURIComponent(renameTarget.id)}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not rename department'));
        return;
      }
      setRenameTarget(null);
      setRenameDepartmentName('');
      setNotice('Department name updated.');
      await load(token);
    } finally {
      setRenameSaving(false);
    }
  }

  async function replaceManagerFromCard(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !replaceManagerTarget) return;
    const email = replaceManagerEmail.trim().toLowerCase();
    if (!email) {
      setError('Manager email is required');
      return;
    }
    setReplaceManagerSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(
        `/departments/${encodeURIComponent(replaceManagerTarget.id)}/assign-manager`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            email,
            full_name: replaceManagerName.trim() || undefined,
            password: replaceManagerPassword.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not replace manager'));
        return;
      }
      setReplaceManagerTarget(null);
      setReplaceManagerName('');
      setReplaceManagerEmail('');
      setReplaceManagerPassword('');
      setNotice('Manager replaced successfully.');
      await load(token);
    } finally {
      setReplaceManagerSaving(false);
    }
  }

  function openPortalPasswordModal(member: TeamMember) {
    setPortalPasswordError(null);
    setPortalPassword('');
    setPortalPasswordConfirm('');
    setPasswordTarget(member);
  }

  function closePortalPasswordModal() {
    setPasswordTarget(null);
    setPortalPasswordError(null);
    setPortalPassword('');
    setPortalPasswordConfirm('');
  }

  function openAlertModal(member: TeamMember) {
    setAlertError(null);
    setAlertMessage('');
    setAlertTarget(member);
  }

  function closeAlertModal() {
    setAlertTarget(null);
    setAlertMessage('');
    setAlertError(null);
  }

  async function submitTeamAlert(e: React.FormEvent) {
    e.preventDefault();
    setAlertError(null);
    if (!alertTarget) return;
    const text = alertMessage.trim();
    if (!text) {
      setAlertError('Enter a message for your team member.');
      return;
    }
    setAlertSaving(true);
    try {
      if (!token) return;
      const res = await apiFetch('/team-alerts/send', token, {
        method: 'POST',
        body: JSON.stringify({ employeeId: alertTarget.id, message: text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAlertError((body.message as string) || 'Could not send alert');
        return;
      }
      closeAlertModal();
      setError(null);
      setNotice(`Message sent to ${alertTarget.name}.`);
    } finally {
      setAlertSaving(false);
    }
  }

  async function submitPortalPassword(e: React.FormEvent) {
    e.preventDefault();
    setPortalPasswordError(null);
    if (!passwordTarget) return;
    if (portalPassword.length < 8) {
      setPortalPasswordError('Password must be at least 8 characters.');
      return;
    }
    if (portalPassword !== portalPasswordConfirm) {
      setPortalPasswordError('Passwords do not match.');
      return;
    }
    setPortalPasswordSaving(true);
    try {
      if (!token) return;
      const res = await apiFetch(
        `/employees/portal-password/${encodeURIComponent(passwordTarget.id)}`,
        token,
        { method: 'PATCH', body: JSON.stringify({ password: portalPassword }) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPortalPasswordError((body.message as string) || 'Could not save password');
        return;
      }
      const action = (body as { action?: string }).action;
      const memberName = passwordTarget.name;
      closePortalPasswordModal();
      setError(null);
      setNotice(
        action === 'login_created'
          ? `Employee portal login created for ${memberName}. Share the email and new password securely.`
          : `Password updated for ${memberName}. Share the new password securely.`,
      );
      await reloadTeam();
    } finally {
      setPortalPasswordSaving(false);
    }
  }

  async function addDepartment(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!token) return;
    const res = await apiFetch('/departments', token, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    if (!res.ok) return setError('Could not create department');
    setName('');
    setCreateOpen(false);
    setNotice('Department created.');
    await load(token);
  }

  async function assignManager(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!token) return;
    if (!managerDepartmentId || !managerEmail.trim()) {
      setError('Department and manager email are required');
      return;
    }
    const res = await apiFetch(
      `/departments/${encodeURIComponent(managerDepartmentId)}/assign-manager`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          email: managerEmail.trim().toLowerCase(),
          full_name: managerName.trim() || undefined,
          password: managerPassword.trim() || undefined,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body.message as string) || 'Could not assign manager');
      return;
    }
    setManagerEmail('');
    setManagerName('');
    setManagerPasswordInput('');
    setManagerDepartmentId('');
    setNotice('Manager assigned successfully.');
    await load(token);
  }

  async function submitConvertManagerToEmployee(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!token) return;
    const email = convertEmail.trim().toLowerCase();
    if (!email || !convertDeptId) {
      setError('Manager email and target team are required');
      return;
    }
    if (
      !window.confirm(
        'This removes them as a department manager and makes them an employee on the team you pick. They keep the same login email and password.',
      )
    ) {
      return;
    }
    setConvertSaving(true);
    try {
      const res = await apiFetch('/employees/convert-manager-to-employee', token, {
        method: 'POST',
        body: JSON.stringify({ email, targetDepartmentId: convertDeptId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.message as string) || 'Could not update this user');
        return;
      }
      const deptName = (body as { departmentName?: string }).departmentName ?? 'the team';
      setConvertEmail('');
      setConvertDeptId('');
      setNotice(
        `They can now sign in at the employee portal with the same account. Placed under ${deptName}.`,
      );
      await load(token);
    } finally {
      setConvertSaving(false);
    }
  }

  async function submitSecondaryTeamRoster(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!token) return;
    const email = secondaryRosterEmail.trim().toLowerCase();
    if (!email || !secondaryRosterDeptId) {
      setError('Manager email and team are required');
      return;
    }
    setSecondaryRosterSaving(true);
    try {
      const res = await apiFetch('/employees/add-secondary-team-roster', token, {
        method: 'POST',
        body: JSON.stringify({ managerEmail: email, departmentId: secondaryRosterDeptId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.message as string) || 'Could not add roster entry');
        return;
      }
      const deptName = (body as { department_name?: string }).department_name ?? 'that team';
      setSecondaryRosterEmail('');
      setSecondaryRosterDeptId('');
      setNotice(
        `They stay a manager on their own team(s) and now also appear under ${deptName} with the same login. Mail is still tracked once (primary mailbox).`,
      );
      await load(token);
    } finally {
      setSecondaryRosterSaving(false);
    }
  }

  async function handleManagerPasswordReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!token) return;
    if (!passwordDepartmentId || !newManagerPassword.trim()) {
      setError('Department and new password are required');
      return;
    }
    const res = await apiFetch(
      `/departments/${encodeURIComponent(passwordDepartmentId)}/manager-password`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ password: newManagerPassword.trim() }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body.message as string) || 'Could not reset manager password');
      return;
    }
    setPasswordDepartmentId('');
    setNewManagerPassword('');
    setNotice('Manager password updated.');
  }

  const me = authMe as Me | null;
  const shellRole = me?.role ?? shellRoleHint ?? 'EMPLOYEE';
  const isBooting = !me || authLoading;
  const isCeo = me?.role === 'CEO';
  const isHead = me ? isDepartmentManagerRole(me.role) : false;
  const ceoMessagesMode = isCeo && locHash === '#team-members';
  const managerEmailSet = useMemo(
    () =>
      new Set(
        rows
          .map((d) => d.manager?.email?.trim().toLowerCase())
          .filter((v): v is string => Boolean(v)),
      ),
    [rows],
  );
  const ceoPeople = useMemo<CxoChatPerson[]>(() => {
    const byEmail = new Map<string, CxoChatPerson>();
    for (const member of teamMembers) {
      const emailNorm = member.email.trim().toLowerCase();
      const isManager = managerEmailSet.has(emailNorm);
      if (!emailNorm) continue;
      byEmail.set(emailNorm, {
        id: member.id,
        name: member.name,
        email: member.email,
        department_name: member.department_name,
        isManager,
        hasEmployeeMailbox: true,
        canMessage: true,
      });
    }
    for (const dept of rows) {
      const mgr = dept.manager;
      if (!mgr?.email?.trim()) continue;
      const emailNorm = mgr.email.trim().toLowerCase();
      if (byEmail.has(emailNorm)) continue;
      byEmail.set(emailNorm, {
        id: `manager:${emailNorm}`,
        name: mgr.full_name?.trim() || 'Manager',
        email: mgr.email,
        department_name: dept.name,
        isManager: true,
        hasEmployeeMailbox: false,
        canMessage: true,
      });
    }
    return Array.from(byEmail.values());
  }, [teamMembers, managerEmailSet, rows]);

  const filteredRecipients = useMemo(() => {
    const q = recipientSearch.trim().toLowerCase();
    return ceoPeople.filter((member) => {
      if (recipientFilter === 'manager' && !member.isManager) return false;
      if (recipientFilter === 'employee' && !member.hasEmployeeMailbox) return false;
      if (!q) return true;
      return (
        member.name.toLowerCase().includes(q) ||
        member.email.toLowerCase().includes(q) ||
        member.department_name.toLowerCase().includes(q)
      );
    });
  }, [ceoPeople, recipientFilter, recipientSearch]);

  const filteredTeamMembers = useMemo(() => {
    const q = recipientSearch.trim().toLowerCase();
    return teamMembers.filter((member) => {
      const isManager = managerEmailSet.has(member.email.trim().toLowerCase());
      if (recipientFilter === 'manager' && !isManager) return false;
      if (!q) return true;
      return (
        member.name.toLowerCase().includes(q) ||
        member.email.toLowerCase().includes(q) ||
        member.department_name.toLowerCase().includes(q)
      );
    });
  }, [teamMembers, managerEmailSet, recipientFilter, recipientSearch]);

  const ceoRootsByEmployee = useMemo(() => {
    const map = new Map<string, SentItem[]>();
    for (const root of ceoSentItems) {
      const arr = map.get(root.employee_id) ?? [];
      arr.push(root);
      map.set(root.employee_id, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    }
    return map;
  }, [ceoSentItems]);
  const ceoRootsByEmail = useMemo(() => {
    const map = new Map<string, SentItem[]>();
    for (const root of ceoSentItems) {
      const key = root.employee_email.trim().toLowerCase();
      if (!key) continue;
      const arr = map.get(key) ?? [];
      arr.push(root);
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    }
    return map;
  }, [ceoSentItems]);

  const ceoChatRows = useMemo(() => {
    return filteredRecipients
      .map((member) => {
        const roots =
          ceoRootsByEmployee.get(member.id) ?? ceoRootsByEmail.get(member.email.trim().toLowerCase()) ?? [];
        const latestRoot = roots.length ? roots[roots.length - 1] : null;
        const latestReply = latestRoot?.replies?.length
          ? latestRoot.replies[latestRoot.replies.length - 1]
          : null;
        const preview = (latestReply?.body ?? latestRoot?.body ?? '').trim();
        const unreadCount = roots.filter((r) => !r.read_at).length;
        const sortKey = latestReply
          ? Date.parse(latestReply.created_at)
          : latestRoot
            ? Date.parse(latestRoot.created_at)
            : 0;
        return { member, roots, preview, unreadCount, sortKey };
      })
      .sort((a, b) => b.sortKey - a.sortKey || a.member.name.localeCompare(b.member.name));
  }, [filteredRecipients, ceoRootsByEmployee, ceoRootsByEmail]);

  const ceoActiveMember = useMemo(
    () => ceoChatRows.find((r) => r.member.id === ceoActiveEmployeeId)?.member ?? ceoChatRows[0]?.member ?? null,
    [ceoChatRows, ceoActiveEmployeeId],
  );
  const ceoActiveRoots = useMemo(
    () =>
      ceoActiveMember
        ? ceoRootsByEmployee.get(ceoActiveMember.id) ??
          ceoRootsByEmail.get(ceoActiveMember.email.trim().toLowerCase()) ??
          []
        : [],
    [ceoActiveMember, ceoRootsByEmployee, ceoRootsByEmail],
  );
  const ceoLatestRoot = ceoActiveRoots.length ? ceoActiveRoots[ceoActiveRoots.length - 1] : null;
  const ceoMessages = useMemo(() => {
    const rows: Array<{ id: string; body: string; createdAt: string; fromManager: boolean; readAt?: string | null }> =
      [];
    for (const root of ceoActiveRoots) {
      rows.push({
        id: root.id,
        body: root.body,
        createdAt: root.created_at,
        fromManager: true,
        readAt: root.read_at,
      });
      for (const reply of root.replies ?? []) {
        rows.push({
          id: reply.id,
          body: reply.body,
          createdAt: reply.created_at,
          fromManager: reply.from_manager,
        });
      }
    }
    rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return rows;
  }, [ceoActiveRoots]);

  useEffect(() => {
    if (!ceoChatRows.length) {
      setCeoActiveEmployeeId(null);
      return;
    }
    if (!ceoActiveEmployeeId || !ceoChatRows.some((row) => row.member.id === ceoActiveEmployeeId)) {
      setCeoActiveEmployeeId(ceoChatRows[0].member.id);
    }
  }, [ceoChatRows, ceoActiveEmployeeId]);

  const ceoActiveDraft = ceoActiveMember ? ceoDraftByEmployeeId[ceoActiveMember.id] ?? '' : '';
  useEffect(() => {
    const el = ceoComposerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [ceoActiveDraft, ceoActiveMember?.id]);

  useEffect(() => {
    const el = ceoChatScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
  }, [ceoActiveMember?.id, ceoMessages.length, ceoSendingForEmployeeId]);

  async function sendCeoMessage(employeeId: string) {
    const text = ceoDraftByEmployeeId[employeeId]?.trim() ?? '';
    if (!token || !text) return;
    setCeoSendingForEmployeeId(employeeId);
    setError(null);
    try {
      const activePerson = ceoPeople.find((p) => p.id === employeeId) ?? null;
      const latestRootForEmployee = (
        ceoRootsByEmployee.get(employeeId) ??
        (activePerson ? ceoRootsByEmail.get(activePerson.email.trim().toLowerCase()) : []) ??
        []
      ).slice(-1)[0] ?? null;
      const isPseudoManagerTarget = employeeId.startsWith('manager:');
      const res = latestRootForEmployee
        ? await apiFetch('/team-alerts/reply-manager', token, {
            method: 'POST',
            body: JSON.stringify({ threadRootId: latestRootForEmployee.id, message: text }),
          })
        : await apiFetch('/team-alerts/send', token, {
            method: 'POST',
            body: JSON.stringify(
              isPseudoManagerTarget
                ? { recipientEmail: activePerson?.email ?? '', message: text }
                : { employeeId, message: text },
            ),
          });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not send your message.'));
        return;
      }
      setCeoDraftByEmployeeId((prev) => ({ ...prev, [employeeId]: '' }));
      await loadCeoSentChats(token);
      if (activePerson) {
        setCeoActiveEmployeeId(activePerson.id);
      }
    } finally {
      setCeoSendingForEmployeeId(null);
    }
  }

  return (
    <AppShell
      role={shellRole}
      companyName={me?.company_name ?? null}
      userDisplayName={authMe?.full_name?.trim() || authMe?.email}
      title={ceoMessagesMode ? 'Messages & alerts' : isCeo ? 'Departments' : 'Messages'}
      subtitle={
        ceoMessagesMode
          ? 'Send messages directly to managers or employees.'
          : isCeo
            ? 'Org structure and manager access.'
            : 'Message your team and manage portal access.'
      }
      onSignOut={() => void ctxSignOut()}
    >
      {isBooting ? <PortalPageLoader variant="embedded" /> : null}
      {!isBooting ? (
        <>
      {isCeo && !ceoMessagesMode ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">Company org</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setCreateOpen(true);
            }}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            Create department
          </button>
        </div>
      ) : null}

      {!ceoMessagesMode ? (
      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">Directory</h2>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-emerald-700">{notice}</p> : null}
        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No departments yet.</p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((d) => (
              <article
                key={d.id}
                className="rounded-xl border border-slate-100 bg-slate-50/50 p-5 transition-colors hover:border-slate-200 hover:bg-white"
              >
                <h3 className="font-semibold text-slate-900">{d.name}</h3>
                <p className="mt-2 text-sm text-slate-600">
                  {d.manager
                    ? `${d.manager.full_name?.trim() || 'Manager'} · ${d.manager.email}`
                    : 'No manager assigned'}
                </p>
                <p className="mt-4 text-xs font-medium text-slate-400">{d.employee_count ?? 0} employees</p>
                {isCeo ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setRenameTarget(d);
                        setRenameDepartmentName(d.name);
                      }}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setReplaceManagerTarget(d);
                        setReplaceManagerName(d.manager?.full_name?.trim() || '');
                        setReplaceManagerEmail(d.manager?.email || '');
                        setReplaceManagerPassword('');
                      }}
                      className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"
                    >
                      Replace manager
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteDepartment(d.id, d.name, d.employee_count ?? 0)}
                      disabled={deletingDeptId === d.id}
                      className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      {deletingDeptId === d.id ? 'Deleting…' : 'Delete department'}
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
      ) : null}

      {isCeo && !ceoMessagesMode ? (
        <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
          <h2 className="text-base font-semibold text-slate-900">Manager assignment</h2>
          <p className="mt-1 text-sm text-slate-500">Assign manager to team.</p>
          <form onSubmit={(e) => void assignManager(e)} className="mt-4 flex max-w-xl flex-col gap-3">
            <select
              value={managerDepartmentId}
              onChange={(e) => setManagerDepartmentId(e.target.value)}
              className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Select team</option>
              {rows.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
              className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="Manager name (optional)"
            />
            <input
              type="email"
              value={managerEmail}
              onChange={(e) => setManagerEmail(e.target.value)}
              className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="Manager email"
              required
            />
            <PasswordInput
              value={managerPassword}
              onChange={(e) => setManagerPasswordInput(e.target.value)}
              className="min-h-[48px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="Password for new login (optional)"
              autoComplete="new-password"
            />
            <button
              type="submit"
              className="min-h-[48px] w-full rounded-lg bg-gray-900 px-5 text-sm font-medium text-white transition-all duration-200 hover:bg-black hover:shadow-md sm:w-auto sm:self-start"
            >
              Assign manager
            </button>
          </form>
        </section>
      ) : null}

      {isCeo && !ceoMessagesMode ? (
        <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
          <h2 className="text-base font-semibold text-slate-900">Advanced manager actions</h2>
          <p className="mt-1 text-sm text-slate-500">Use only when needed.</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setAdvancedAction((a) => (a === 'secondary' ? null : 'secondary'))}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                advancedAction === 'secondary'
                  ? 'bg-indigo-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Add manager to another team
            </button>
            <button
              type="button"
              onClick={() => setAdvancedAction((a) => (a === 'convert' ? null : 'convert'))}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                advancedAction === 'convert'
                  ? 'bg-amber-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Move manager to employee portal
            </button>
            <button
              type="button"
              onClick={() => setAdvancedAction((a) => (a === 'password' ? null : 'password'))}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                advancedAction === 'password'
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Reset manager password
            </button>
          </div>

          {advancedAction === 'secondary' ? (
            <form onSubmit={(e) => void submitSecondaryTeamRoster(e)} className="mt-5 flex max-w-xl flex-col gap-3">
              <p className="text-sm text-slate-500">Add existing manager to another team roster.</p>
              <input
                type="email"
                value={secondaryRosterEmail}
                onChange={(e) => setSecondaryRosterEmail(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                placeholder="Manager login email"
                required
                autoComplete="off"
              />
              <select
                value={secondaryRosterDeptId}
                onChange={(e) => setSecondaryRosterDeptId(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="">Select team</option>
                {rows.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={secondaryRosterSaving}
                className="min-h-[48px] w-full rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 sm:w-auto sm:self-start"
              >
                {secondaryRosterSaving ? 'Saving…' : 'Add to team'}
              </button>
            </form>
          ) : null}

          {advancedAction === 'convert' ? (
            <form onSubmit={(e) => void submitConvertManagerToEmployee(e)} className="mt-5 flex max-w-xl flex-col gap-3">
              <p className="text-sm text-slate-500">Remove manager role and keep same login as employee.</p>
              <input
                type="email"
                value={convertEmail}
                onChange={(e) => setConvertEmail(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                placeholder="Manager login email"
                required
                autoComplete="off"
              />
              <select
                value={convertDeptId}
                onChange={(e) => setConvertDeptId(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="">Select employee team</option>
                {rows.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={convertSaving}
                className="min-h-[48px] w-full rounded-lg border border-amber-200 bg-amber-50 px-5 text-sm font-medium text-amber-950 transition hover:bg-amber-100 disabled:opacity-50 sm:w-auto sm:self-start"
              >
                {convertSaving ? 'Updating…' : 'Move to employee portal'}
              </button>
            </form>
          ) : null}

          {advancedAction === 'password' ? (
            <form
              onSubmit={(e) => void handleManagerPasswordReset(e)}
              className="mt-5 flex max-w-xl flex-col gap-3"
            >
              <p className="text-sm text-slate-500">Set a new password for current manager login.</p>
              <select
                value={passwordDepartmentId}
                onChange={(e) => setPasswordDepartmentId(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="">Select team</option>
                {rows.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <PasswordInput
                value={newManagerPassword}
                onChange={(e) => setNewManagerPassword(e.target.value)}
                className="min-h-[48px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                placeholder="New password (min 8 chars)"
                required
                autoComplete="new-password"
              />
              <button
                type="submit"
                className="min-h-[48px] w-full rounded-lg bg-gray-900 px-5 text-sm font-medium text-white transition-all duration-200 hover:bg-black hover:shadow-md sm:w-auto sm:self-start"
              >
                Update password
              </button>
            </form>
          ) : null}
        </section>
      ) : null}

      {isHead || (isCeo && ceoMessagesMode) ? (
        <section
          id="team-members"
          className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02] scroll-mt-24"
        >
          <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{isCeo ? 'Messages & alerts' : 'Team'}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {isCeo
                  ? 'Send messages directly to managers or employees.'
                  : 'Portal access and team messages.'}
              </p>
            </div>
          </div>
          {teamLoadError ? <p className="text-sm text-red-600">{teamLoadError}</p> : null}
          {!teamLoadError && teamMembers.length === 0 ? (
            <p className="text-sm text-slate-500">
              No team members yet. Add mailboxes from <span className="font-medium text-slate-800">Employees</span>.
            </p>
          ) : null}
          {teamMembers.length > 0 && isCeo && ceoMessagesMode ? (
            <section className="overflow-hidden rounded-3xl border border-slate-200/70 bg-white shadow-card">
              <div className="grid min-h-[68vh] lg:grid-cols-[340px_minmax(0,1fr)]">
                <aside className="border-r border-slate-200 bg-white">
                  <div className="border-b border-slate-100 px-4 py-3">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      {(['all', 'manager', 'employee'] as RecipientFilter[]).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => setRecipientFilter(kind)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                            recipientFilter === kind
                              ? 'bg-indigo-600 text-white'
                              : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {kind === 'all' ? 'All people' : kind === 'manager' ? 'Managers' : 'Employees'}
                        </button>
                      ))}
                    </div>
                    <input
                      value={recipientSearch}
                      onChange={(e) => setRecipientSearch(e.target.value)}
                      placeholder="Search chats"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none ring-brand-500 placeholder:text-slate-400 focus:ring-1"
                    />
                  </div>
                  <div className="max-h-[68vh] overflow-y-auto p-2">
                    {ceoChatRows.length === 0 ? (
                      <div className="px-3 py-5 text-sm text-slate-500">No team members match your filter.</div>
                    ) : null}
                    <ul className="space-y-1">
                      {ceoChatRows.map((row) => {
                        const active = ceoActiveMember?.id === row.member.id;
                        return (
                          <li key={row.member.id}>
                            <button
                              type="button"
                              onClick={() => setCeoActiveEmployeeId(row.member.id)}
                              className={`w-full rounded-xl px-3 py-2 text-left ${
                                active ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'hover:bg-slate-50'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-900">{row.member.name}</p>
                                  <p className="truncate text-xs text-slate-500">{row.member.email}</p>
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-1">
                                  {row.sortKey > 0 ? (
                                    <p className="text-[10px] text-slate-400">
                                      {new Date(row.sortKey).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                    </p>
                                  ) : null}
                                  {row.unreadCount > 0 ? (
                                    <span className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-white">
                                      {row.unreadCount}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <p className="mt-1 truncate text-xs text-slate-600">
                                {row.preview || 'No messages yet. Send the first one.'}
                              </p>
                              <p className="mt-1 text-[10px] text-slate-400">
                                {row.member.department_name} · {row.member.isManager ? 'Manager' : 'Employee'}
                              </p>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </aside>
                <div className="flex min-h-0 flex-col bg-[#efeae2]/70">
                  {ceoActiveMember ? (
                    <>
                      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{ceoActiveMember.name}</p>
                          <p className="text-xs text-slate-500">
                            {ceoActiveMember.email} · {ceoActiveMember.department_name}
                          </p>
                        </div>
                      </header>
                      <div ref={ceoChatScrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                        {ceoMessages.length === 0 ? (
                          <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
                            No messages yet. Send the first message.
                          </div>
                        ) : null}
                        {ceoMessages.map((msg, idx) => {
                          const prev = idx > 0 ? ceoMessages[idx - 1] : null;
                          const showDateSeparator =
                            !prev || !isSameCalendarDay(new Date(prev.createdAt), new Date(msg.createdAt));
                          return (
                            <div key={msg.id} className="space-y-2">
                              {showDateSeparator ? (
                                <div className="sticky top-1 z-10 flex justify-center">
                                  <span className="rounded-full border border-slate-200 bg-white/95 px-2 py-0.5 text-[10px] font-medium text-slate-500 shadow-sm backdrop-blur">
                                    {dateSeparatorLabel(msg.createdAt)}
                                  </span>
                                </div>
                              ) : null}
                              <div className={`flex ${msg.fromManager ? 'justify-end' : 'justify-start'}`}>
                                <div
                                  className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                                    msg.fromManager
                                      ? 'rounded-br-sm bg-emerald-600 text-white'
                                      : 'rounded-bl-sm bg-white text-slate-800'
                                  }`}
                                >
                                  <p className="whitespace-pre-wrap">{msg.body}</p>
                                  <div
                                    className={`mt-1 flex justify-end gap-2 text-[10px] ${
                                      msg.fromManager ? 'text-emerald-100' : 'text-slate-400'
                                    }`}
                                  >
                                    <span>{new Date(msg.createdAt).toLocaleString()}</span>
                                    {msg.fromManager ? (
                                      <span>{msg.readAt ? 'Seen' : 'Delivered'}</span>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="border-t border-slate-200 bg-white px-3 py-3">
                        <div className="flex items-end gap-2">
                          <textarea
                            ref={ceoComposerRef}
                            rows={1}
                            value={ceoDraftByEmployeeId[ceoActiveMember.id] ?? ''}
                            onChange={(e) =>
                              setCeoDraftByEmployeeId((prev) => ({
                                ...prev,
                                [ceoActiveMember.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return;
                              if (e.shiftKey) return;
                              e.preventDefault();
                              if (ceoSendingForEmployeeId === ceoActiveMember.id) return;
                              void sendCeoMessage(ceoActiveMember.id);
                            }}
                            disabled={
                              ceoSendingForEmployeeId === ceoActiveMember.id || !ceoActiveMember.canMessage
                            }
                            placeholder={ceoActiveMember.canMessage ? 'Type a message' : 'Type a message'}
                            className="min-h-[44px] w-full resize-none rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                          />
                          <button
                            type="button"
                            onClick={() => void sendCeoMessage(ceoActiveMember.id)}
                            disabled={
                              ceoSendingForEmployeeId === ceoActiveMember.id ||
                              !(ceoDraftByEmployeeId[ceoActiveMember.id]?.trim())
                            }
                            className="h-11 shrink-0 rounded-2xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 text-xs font-semibold text-white hover:opacity-95 disabled:opacity-50"
                          >
                            {ceoSendingForEmployeeId === ceoActiveMember.id ? 'Sending…' : 'Send'}
                          </button>
                        </div>
                        {ceoLatestRoot ? (
                          <p className="mt-1 px-1 text-[10px] text-slate-400">
                            Replying in existing thread with {ceoActiveMember.name}.
                          </p>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center p-6 text-center">
                      <p className="max-w-sm text-sm text-slate-600">
                        Select a person from the left to start messaging.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          ) : null}
          {teamMembers.length > 0 && isCeo && !ceoMessagesMode ? (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {(['all', 'manager', 'employee'] as RecipientFilter[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setRecipientFilter(kind)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                      recipientFilter === kind
                        ? 'bg-indigo-600 text-white'
                        : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {kind === 'all' ? 'All people' : kind === 'manager' ? 'Managers' : 'Employees'}
                  </button>
                ))}
                <input
                  value={recipientSearch}
                  onChange={(e) => setRecipientSearch(e.target.value)}
                  placeholder="Search name, email, team..."
                  className="ml-auto w-full min-w-[220px] rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 sm:w-72"
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {filteredTeamMembers.map((member) => {
                  const isManager = managerEmailSet.has(member.email.trim().toLowerCase());
                  return (
                    <article key={member.id} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900">{member.name}</p>
                          <p className="truncate text-xs text-slate-500">{member.email}</p>
                          <p className="mt-1 text-[11px] text-slate-500">{member.department_name}</p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            isManager ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {isManager ? 'Manager' : 'Employee'}
                        </span>
                      </div>
                      <div className="mt-3 flex items-center justify-end">
                        <button
                          type="button"
                          onClick={() => openAlertModal(member)}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 transition hover:bg-gray-50"
                        >
                          Send message
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}
          {teamMembers.length > 0 && isHead ? (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Login email</th>
                    <th className="px-4 py-3">Gmail</th>
                    <th className="px-4 py-3">Last sync</th>
                    <th className="px-4 py-3">Portal login</th>
                    <th className="px-4 py-3">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {teamMembers.map((e) => (
                    <tr key={e.id} className="hover:bg-gray-50/80">
                      <td className="px-4 py-3 font-medium text-gray-900">{e.name}</td>
                      <td className="px-4 py-3 text-gray-600">{e.email}</td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            (e.gmail_status ?? 'EXPIRED') === 'CONNECTED'
                              ? 'font-medium text-emerald-700'
                              : 'font-medium text-amber-800'
                          }
                        >
                          {(e.gmail_status ?? 'EXPIRED') === 'CONNECTED' ? 'Connected' : 'Not connected'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {e.last_synced_at ? new Date(e.last_synced_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openPortalPasswordModal(e)}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-950 transition hover:bg-amber-100"
                        >
                          {e.has_portal_login ? 'Change password' : 'Set up password'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openAlertModal(e)}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 transition hover:bg-gray-50"
                        >
                          Send message
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {isCeo && createOpen && !ceoMessagesMode ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-dept-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setCreateOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 id="create-dept-title" className="text-lg font-semibold text-slate-900">
              New department
            </h3>
            <form onSubmit={(e) => void addDepartment(e)} className="mt-4 space-y-4">
              {error ? <p className="text-sm text-red-600">{error}</p> : null}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                placeholder="Department name"
                required
                autoFocus
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreateOpen(false);
                    setError(null);
                  }}
                  className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isCeo && renameTarget && !ceoMessagesMode ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-dept-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setRenameTarget(null);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 id="rename-dept-title" className="text-lg font-semibold text-slate-900">
              Rename department
            </h3>
            <p className="mt-1 text-sm text-slate-500">Update the department name only.</p>
            <form onSubmit={(e) => void renameDepartmentFromCard(e)} className="mt-4 space-y-4">
              <input
                value={renameDepartmentName}
                onChange={(e) => setRenameDepartmentName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                placeholder="Department name"
                required
                autoFocus
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={renameSaving}
                  className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {renameSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setRenameTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isCeo && replaceManagerTarget && !ceoMessagesMode ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="replace-manager-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setReplaceManagerTarget(null);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 id="replace-manager-title" className="text-lg font-semibold text-slate-900">
              Replace manager
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Team: <span className="font-medium text-slate-700">{replaceManagerTarget.name}</span>
            </p>
            <form onSubmit={(e) => void replaceManagerFromCard(e)} className="mt-4 space-y-3">
              <input
                value={replaceManagerName}
                onChange={(e) => setReplaceManagerName(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                placeholder="Manager name (optional)"
              />
              <input
                type="email"
                value={replaceManagerEmail}
                onChange={(e) => setReplaceManagerEmail(e.target.value)}
                className="min-h-[48px] w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                placeholder="Manager email"
                required
                autoFocus
              />
              <PasswordInput
                value={replaceManagerPassword}
                onChange={(e) => setReplaceManagerPassword(e.target.value)}
                className="min-h-[48px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
                placeholder="Password for new login (optional)"
                autoComplete="new-password"
              />
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  disabled={replaceManagerSaving}
                  className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {replaceManagerSaving ? 'Saving…' : 'Replace manager'}
                </button>
                <button
                  type="button"
                  onClick={() => setReplaceManagerTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {alertTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="team-alert-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) closeAlertModal();
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 id="team-alert-title" className="text-lg font-bold text-slate-900">
              Message · {alertTarget.name}
            </h3>
            <p className="mt-1 text-sm text-slate-500">This appears in their Messages area and dashboard.</p>
            <form onSubmit={(e) => void submitTeamAlert(e)} className="mt-5 space-y-4">
              {alertError ? <p className="text-sm text-red-600">{alertError}</p> : null}
              <textarea
                value={alertMessage}
                onChange={(ev) => setAlertMessage(ev.target.value)}
                placeholder="Your message…"
                rows={4}
                maxLength={4000}
                className="w-full resize-y rounded-xl border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-brand-500"
                required
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={alertSaving}
                  className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-95 disabled:opacity-60"
                >
                  {alertSaving ? 'Sending…' : 'Send'}
                </button>
                <button
                  type="button"
                  onClick={() => closeAlertModal()}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {passwordTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="portal-password-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) closePortalPasswordModal();
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 id="portal-password-title" className="text-lg font-semibold text-gray-900">
              {passwordTarget.has_portal_login ? 'Change password' : 'Set up Employee portal login'}
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              {passwordTarget.name} · <span className="font-medium text-gray-800">{passwordTarget.email}</span>
            </p>
            <p className="mt-1 text-xs text-gray-500">
              They sign in at the Employee portal with this email and the password you choose. Minimum 8 characters.
            </p>
            <form onSubmit={(e) => void submitPortalPassword(e)} className="mt-4 space-y-3">
              {portalPasswordError ? <p className="text-sm text-red-600">{portalPasswordError}</p> : null}
              <PasswordInput
                value={portalPassword}
                onChange={(ev) => setPortalPassword(ev.target.value)}
                placeholder="New password"
                className="rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500"
                minLength={8}
                autoComplete="new-password"
                required
              />
              <PasswordInput
                value={portalPasswordConfirm}
                onChange={(ev) => setPortalPasswordConfirm(ev.target.value)}
                placeholder="Confirm password"
                className="rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500"
                minLength={8}
                autoComplete="new-password"
                required
              />
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="submit"
                  disabled={portalPasswordSaving}
                  className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
                >
                  {portalPasswordSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => closePortalPasswordModal()}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
        </>
      ) : null}
    </AppShell>
  );
}
