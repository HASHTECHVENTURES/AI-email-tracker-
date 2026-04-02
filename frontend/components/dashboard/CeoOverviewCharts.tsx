'use client';

import Link from 'next/link';

export type DepartmentRollup = {
  department_id: string;
  department_name: string;
  manager_name: string | null;
  manager_email: string | null;
  total_threads: number;
  missed: number;
  pending: number;
  done: number;
  need_attention_count: number;
};

type Conv = {
  follow_up_status: string;
  priority: string;
  employee_name: string;
};

type Props = {
  conversations: Conv[];
  needsAttentionCount: number;
  employeeCount: number;
  mailboxesConnected: number;
  departmentRollups: DepartmentRollup[];
};

function pct(n: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (n / total) * 100)).toFixed(1)}%`;
}

function segPct(n: number, denom: number): string {
  if (denom <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (n / denom) * 100)).toFixed(2)}%`;
}

export function CeoOverviewCharts({
  conversations,
  needsAttentionCount,
  employeeCount,
  mailboxesConnected,
  departmentRollups,
}: Props) {
  const total = conversations.length;
  const done = conversations.filter((c) => c.follow_up_status === 'DONE').length;
  const pending = conversations.filter((c) => c.follow_up_status === 'PENDING').length;
  const missed = conversations.filter((c) => c.follow_up_status === 'MISSED').length;

  const high = conversations.filter((c) => c.priority === 'HIGH').length;
  const medium = conversations.filter((c) => c.priority === 'MEDIUM').length;
  const low = conversations.filter((c) => c.priority === 'LOW').length;
  const priTotal = Math.max(1, high + medium + low);

  const byMailbox = new Map<string, number>();
  for (const c of conversations) {
    const key = (c.employee_name || 'Unassigned').trim() || 'Unassigned';
    byMailbox.set(key, (byMailbox.get(key) ?? 0) + 1);
  }
  const workloadCounts = [...byMailbox.values()].sort((a, b) => b - a).slice(0, 10);
  const maxLoad = workloadCounts.reduce((m, n) => Math.max(m, n), 0) || 1;

  const card =
    'rounded-2xl border border-slate-200/90 bg-white p-5 shadow-md shadow-slate-900/[0.04] ring-1 ring-slate-900/[0.03]';

  const base = Math.max(1, total);

  const topFocus = departmentRollups.slice(0, 3);

  return (
    <div className="space-y-6">
      {departmentRollups.length > 0 ? (
        <>
          <section className={card}>
            <h3 className="text-sm font-semibold text-slate-900">Where to focus first</h3>
            <p className="mt-1 text-xs text-slate-500">
              Ranked by need-attention load, then missed SLAs. Each card is a department and its assigned manager (user
              role HEAD linked to that department).
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {topFocus.map((d) => {
                const hot = d.need_attention_count > 0 || d.missed > 0;
                return (
                  <div
                    key={d.department_id}
                    className={`rounded-xl border px-4 py-3 ${
                      hot ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-slate-50/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold leading-snug text-slate-900">{d.department_name}</p>
                      {hot ? (
                        <span className="shrink-0 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                          Important
                        </span>
                      ) : (
                        <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">
                          Stable
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-slate-600">
                      Manager:{' '}
                      <span className="font-medium text-slate-800">
                        {d.manager_name?.trim() || '— not assigned'}
                      </span>
                    </p>
                    {d.manager_email ? (
                      <p className="truncate text-[11px] text-slate-500">{d.manager_email}</p>
                    ) : null}
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-slate-500">Need attention</dt>
                        <dd className="font-semibold tabular-nums text-rose-700">{d.need_attention_count}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Missed SLA</dt>
                        <dd className="font-semibold tabular-nums text-amber-800">{d.missed}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Threads</dt>
                        <dd className="font-medium tabular-nums text-slate-800">{d.total_threads}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Pending</dt>
                        <dd className="font-medium tabular-nums text-slate-700">{d.pending}</dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </div>
          </section>

          <section className={card}>
            <h3 className="text-sm font-semibold text-slate-900">Departments — thread mix</h3>
            <p className="mt-1 text-xs text-slate-500">
              Each row is one department and its manager. Segments: resolved / pending / missed.
            </p>
            <ul className="mt-5 space-y-5">
              {departmentRollups.map((d) => {
                const t = Math.max(1, d.total_threads);
                return (
                  <li key={d.department_id}>
                    <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <span className="text-sm font-medium text-slate-900">{d.department_name}</span>
                        <span className="ml-2 text-xs text-slate-500">
                          Manager: {d.manager_name?.trim() || '—'}
                        </span>
                      </div>
                      <span className="text-xs tabular-nums text-slate-500">{d.total_threads} threads</span>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                      <div className="h-9 min-w-0 flex-1 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200/80">
                        <div className="flex h-full w-full min-w-0">
                          <div
                            className="h-full min-w-0 bg-emerald-500"
                            style={{ width: segPct(d.done, t) }}
                            title={`Done ${d.done}`}
                          />
                          <div
                            className="h-full min-w-0 bg-amber-400"
                            style={{ width: segPct(d.pending, t) }}
                            title={`Pending ${d.pending}`}
                          />
                          <div
                            className="h-full min-w-0 bg-rose-500"
                            style={{ width: segPct(d.missed, t) }}
                            title={`Missed ${d.missed}`}
                          />
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-3 text-[11px] text-slate-600 sm:min-w-[140px]">
                        <span>
                          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500 align-middle" /> {d.done}
                        </span>
                        <span>
                          <span className="inline-block h-2 w-2 rounded-sm bg-amber-400 align-middle" /> {d.pending}
                        </span>
                        <span>
                          <span className="inline-block h-2 w-2 rounded-sm bg-rose-500 align-middle" /> {d.missed}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : (
        <section className={card}>
          <h3 className="text-sm font-semibold text-slate-900">Departments &amp; managers</h3>
          <p className="mt-2 text-sm text-slate-600">
            These charts only show department names and department managers (HEAD users). They do not list individual
            team member names.
          </p>
          <p className="mt-4 text-sm text-slate-600">
            No departments were returned yet. Create departments and assign a manager (HEAD) to each under{' '}
            <Link href="/departments" className="font-semibold text-indigo-600 hover:text-indigo-800">
              Departments
            </Link>
            .
          </p>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className={card}>
          <h3 className="text-sm font-semibold text-slate-900">Conversation pipeline</h3>
          <p className="mt-1 text-xs text-slate-500">Share of all active threads by outcome — no sender data.</p>
          {total === 0 ? (
            <p className="mt-6 text-sm text-slate-500">No conversation data yet.</p>
          ) : (
            <>
              <div className="mt-4 flex h-5 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/80">
                <div
                  className="bg-emerald-500 transition-all duration-500"
                  style={{ width: pct(done, base) }}
                  title={`Resolved ${done}`}
                />
                <div
                  className="bg-amber-400 transition-all duration-500"
                  style={{ width: pct(pending, base) }}
                  title={`Pending ${pending}`}
                />
                <div
                  className="bg-rose-500 transition-all duration-500"
                  style={{ width: pct(missed, base) }}
                  title={`Missed SLA ${missed}`}
                />
              </div>
              <ul className="mt-4 flex flex-wrap gap-4 text-xs">
                <li className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-slate-600">
                    Resolved <strong className="text-slate-900">{done}</strong> ({pct(done, base)})
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                  <span className="text-slate-600">
                    Pending <strong className="text-slate-900">{pending}</strong> ({pct(pending, base)})
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  <span className="text-slate-600">
                    Missed SLA <strong className="text-slate-900">{missed}</strong> ({pct(missed, base)})
                  </span>
                </li>
              </ul>
            </>
          )}
        </div>

        <div className={card}>
          <h3 className="text-sm font-semibold text-slate-900">Priority mix</h3>
          <p className="mt-1 text-xs text-slate-500">AI-assigned priority across all threads.</p>
          <div className="mt-6 flex h-[140px] items-end justify-center gap-8 px-2">
            {[
              { label: 'High', n: high, color: 'bg-rose-500' },
              { label: 'Medium', n: medium, color: 'bg-amber-500' },
              { label: 'Low', n: low, color: 'bg-slate-400' },
            ].map(({ label, n, color }) => {
              const barPx = n === 0 ? 4 : Math.max(16, Math.round((n / priTotal) * 120));
              return (
                <div key={label} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
                  <span className="text-xs font-medium tabular-nums text-slate-700">{n}</span>
                  <div
                    className={`w-full max-w-[3.5rem] rounded-t-md ${color} transition-all duration-500`}
                    style={{ height: barPx }}
                    title={`${label}: ${n}`}
                  />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className={card}>
          <h3 className="text-sm font-semibold text-slate-900">Load distribution</h3>
          <p className="mt-1 text-xs text-slate-500">
            Busiest tracked mailboxes by thread count (ranked #1–#10, no client addresses).
          </p>
          {workloadCounts.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">No data.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {workloadCounts.map((count, idx) => (
                <li key={idx}>
                  <div className="mb-1 flex justify-between text-xs text-slate-600">
                    <span className="font-medium text-slate-800">Rank #{idx + 1}</span>
                    <span className="shrink-0 tabular-nums text-slate-500">{count} threads</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                      style={{ width: `${(count / maxLoad) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={card}>
          <h3 className="text-sm font-semibold text-slate-900">Operations snapshot</h3>
          <p className="mt-1 text-xs text-slate-500">Coverage and attention load (aggregates only).</p>
          <dl className="mt-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <dt className="text-sm text-slate-600">Threads needing attention</dt>
              <dd className="text-2xl font-semibold tabular-nums text-rose-600">{needsAttentionCount}</dd>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <dt className="text-sm text-slate-600">Total open threads</dt>
              <dd className="text-2xl font-semibold tabular-nums text-slate-900">{total}</dd>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <dt className="text-sm text-slate-600">Tracked mailboxes (connected)</dt>
              <dd className="text-2xl font-semibold tabular-nums text-slate-900">
                {mailboxesConnected}
                <span className="text-sm font-normal text-slate-500"> / {employeeCount}</span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
