'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, readApiErrorMessage, tryRecoverFromUnauthorized } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { Badge } from '@/components/Badge';
import { ConversationThreadReader, type ThreadMessageDto } from '@/components/ConversationThreadReader';

type ThreadMeta = {
  client_email: string | null;
  client_name: string | null;
  employee_name: string;
  open_gmail_link: string;
  short_reason: string;
  reason: string;
  summary: string;
  follow_up_status: string;
  priority: string;
};

type MessagesPayload = {
  conversation_id: string;
  thread: ThreadMeta;
  messages: ThreadMessageDto[];
};

function safeFromPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function ConversationReadPageInner() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const conversationId =
    typeof params.conversationId === 'string' ? decodeURIComponent(params.conversationId) : '';

  const fromQuery = useMemo(() => safeFromPath(searchParams.get('from')), [searchParams]);

  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [payload, setPayload] = useState<MessagesPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'resolve' | 'delete' | null>(null);

  const goBack = useCallback(() => {
    if (fromQuery) {
      router.push(fromQuery);
      return;
    }
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/dashboard');
  }, [fromQuery, router]);

  useEffect(() => {
    if (!conversationId.trim() || !token) return;
    let cancelled = false;
    setLoadError(null);
    setPayload(null);
    void (async () => {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/messages`, token);
      if (cancelled) return;
      if (!res.ok) {
        if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
        setLoadError(await readApiErrorMessage(res, 'Could not load this thread.'));
        return;
      }
      const j = (await res.json()) as MessagesPayload;
      if (!j.thread || !Array.isArray(j.messages)) {
        setLoadError('Invalid response from server.');
        return;
      }
      setPayload(j);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, ctxSignOut]);

  async function markDone() {
    if (!token || !conversationId) return;
    setBusyAction('resolve');
    try {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/mark-done`, token, {
        method: 'POST',
      });
      if (!res.ok) {
        if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
        setLoadError(await readApiErrorMessage(res, 'Could not update.'));
        return;
      }
      goBack();
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteThread() {
    if (!token || !conversationId || !payload) return;
    const hint = payload.thread.client_email?.trim();
    const label = hint ? ` — ${hint}` : '';
    if (
      !window.confirm(
        `Permanently delete this thread${label}? Synced messages for this conversation will be removed. This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusyAction('delete');
    try {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}`, token, {
        method: 'DELETE',
      });
      if (!res.ok) {
        if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
        setLoadError(await readApiErrorMessage(res, 'Could not delete this thread.'));
        return;
      }
      goBack();
    } finally {
      setBusyAction(null);
    }
  }

  if (authLoading || !me) {
    return (
      <AppShell
        role=""
        companyName={null}
        userDisplayName=""
        title="Thread"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  if (!token) {
    router.replace('/auth');
    return null;
  }

  if (!conversationId.trim()) {
    return (
      <AppShell
        role={me.role}
        companyName={me.company_name ?? null}
        userDisplayName={me.full_name?.trim() || me.email}
        title="Thread"
        subtitle="Missing conversation id"
        onSignOut={() => void ctxSignOut()}
      >
        <p className="text-sm text-slate-600">
          <Link href="/dashboard" className="font-semibold text-brand-600 hover:underline">
            Back to dashboard
          </Link>
        </p>
      </AppShell>
    );
  }

  const t = payload?.thread;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      title={t?.client_email?.trim() || t?.client_name?.trim() || 'Thread'}
      subtitle={t ? `${t.employee_name} · ${t.follow_up_status}` : 'Loading…'}
      onSignOut={() => void ctxSignOut()}
    >
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => goBack()}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            ← Back
          </button>
          {t ? (
            <>
              <a
                href={t.open_gmail_link}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
              >
                Open in Gmail
              </a>
              <button
                type="button"
                onClick={() => void markDone()}
                disabled={busyAction !== null}
                className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
              >
                {busyAction === 'resolve' ? 'Resolving…' : 'Resolve'}
              </button>
              <button
                type="button"
                onClick={() => void deleteThread()}
                disabled={busyAction !== null || !payload}
                className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {busyAction === 'delete' ? 'Deleting…' : 'Delete thread'}
              </button>
            </>
          ) : null}
        </div>

        {loadError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{loadError}</div>
        ) : null}

        {!payload && !loadError ? (
          <PortalPageLoader variant="embedded" dense />
        ) : null}

        {t && payload ? (
          <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
            {(t.client_email ?? '').trim().length > 0 ? (
              <p className="text-sm text-slate-700">
                <span className="font-semibold text-slate-900">Primary client for this thread: </span>
                {t.client_email}
                {(t.client_name ?? '').trim().length > 0 ? ` (${t.client_name})` : null}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Badge
                tone={
                  t.follow_up_status === 'MISSED'
                    ? 'missed'
                    : t.follow_up_status === 'PENDING'
                      ? 'pending'
                      : 'done'
                }
              >
                {t.follow_up_status}
              </Badge>
              <Badge tone={t.priority === 'HIGH' ? 'high' : t.priority === 'MEDIUM' ? 'medium' : 'low'}>
                {t.priority}
              </Badge>
            </div>
            {(t.short_reason ?? '').trim().length > 0 ? (
              <p className="text-sm text-slate-800">{t.short_reason}</p>
            ) : null}
            {(t.reason ?? '').trim().length > 0 && t.reason !== t.short_reason ? (
              <p className="text-sm text-slate-600">{t.reason}</p>
            ) : null}
            {(t.summary ?? '').trim().length > 0 ? (
              <p className="text-sm text-slate-600">{t.summary}</p>
            ) : null}
          </section>
        ) : null}

        {payload ? (
          <div className="mt-8">
            <p className="mb-3 text-xs text-slate-500">
              Each sync stores full message text from Gmail. If something still looks like a short preview, run sync
              again so older rows can be updated.
            </p>
            <ConversationThreadReader
              conversationId={conversationId}
              token={token}
              messagesData={payload.messages}
              trackedClientEmail={payload.thread.client_email}
            />
          </div>
        ) : null}
    </AppShell>
  );
}

export default function ConversationReadPage() {
  return (
    <Suspense
      fallback={<PortalPageLoader variant="fullscreen" />}
    >
      <ConversationReadPageInner />
    </Suspense>
  );
}
