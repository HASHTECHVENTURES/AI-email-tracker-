'use client';

import { useEffect, useRef, useState } from 'react';

export type CeoDeptDirectoryRow = {
  id: string;
  name: string;
  manager: { full_name: string | null; email: string } | null;
};

export type CeoScopeOrgEmployee = {
  id: string;
  name: string;
  email: string;
  department_id: string | null;
  department_name: string;
};

type Props = {
  /**
   * Slide-over: when the panel opens, draft selections sync from the dashboard.
   * Full page (`embedded`): draft tracks `selected*` whenever they change.
   */
  panelOpen?: boolean;
  /** Full-page scope UI — draft stays in sync with applied selection from the parent. */
  embedded?: boolean;
  departmentOptions: CeoDeptDirectoryRow[];
  orgEmployees: CeoScopeOrgEmployee[];
  selectedDepartmentIds: string[];
  selectedEmployeeIds: string[];
  onApply: (departmentIds: string[], employeeIds: string[]) => void;
  loadingEmployees: boolean;
};

function managerLabel(d: CeoDeptDirectoryRow): string {
  return d.manager?.full_name?.trim() || d.manager?.email?.trim() || 'Manager';
}

function isManagerMailbox(emp: CeoScopeOrgEmployee, departments: CeoDeptDirectoryRow[]): boolean {
  if (!emp.department_id || !emp.email?.trim()) return false;
  const dept = departments.find((x) => x.id === emp.department_id);
  const em = dept?.manager?.email?.trim().toLowerCase();
  return Boolean(em && em === emp.email.trim().toLowerCase());
}

function checkboxClass(checked: boolean): string {
  return [
    'mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500',
    checked ? '' : '',
  ].join(' ');
}

export function CeoDashboardScopePanel({
  panelOpen = true,
  embedded = false,
  departmentOptions,
  orgEmployees,
  selectedDepartmentIds,
  selectedEmployeeIds,
  onApply,
  loadingEmployees,
}: Props) {
  const [draftDepts, setDraftDepts] = useState<string[]>([]);
  const [draftEmps, setDraftEmps] = useState<string[]>([]);
  const prevPanelOpen = useRef(false);
  const embeddedSelectionSig = useRef<string | null>(null);

  useEffect(() => {
    if (embedded) {
      const sig = `${[...selectedDepartmentIds].sort().join(',')}|${[...selectedEmployeeIds].sort().join(',')}`;
      if (embeddedSelectionSig.current === sig) return;
      embeddedSelectionSig.current = sig;
      setDraftDepts([...selectedDepartmentIds]);
      setDraftEmps([...selectedEmployeeIds]);
      return;
    }
    if (panelOpen && !prevPanelOpen.current) {
      setDraftDepts([...selectedDepartmentIds]);
      setDraftEmps([...selectedEmployeeIds]);
    }
    prevPanelOpen.current = panelOpen;
  }, [embedded, panelOpen, selectedDepartmentIds, selectedEmployeeIds]);

  const draftDeptSet = new Set(draftDepts);
  const draftEmpSet = new Set(draftEmps);

  const managerDepts = departmentOptions
    .filter((d) => d.manager?.full_name?.trim() || d.manager?.email?.trim())
    .slice()
    .sort((a, b) => managerLabel(a).localeCompare(managerLabel(b)));

  const teammateRows = orgEmployees
    .filter((e) => !isManagerMailbox(e, departmentOptions))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggleDraftDept = (id: string) => {
    setDraftDepts((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return [...s];
    });
  };

  const toggleDraftEmp = (id: string) => {
    setDraftEmps((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return [...s];
    });
  };

  const clearDraft = () => {
    setDraftDepts([]);
    setDraftEmps([]);
  };

  const rowWrap = (selected: boolean) =>
    selected
      ? 'flex cursor-pointer gap-3 rounded-xl border-2 border-brand-500 bg-brand-50/70 px-3 py-2.5 shadow-sm'
      : 'flex cursor-pointer gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 hover:border-slate-300 hover:bg-slate-50/80';

  const selectionSummary =
    draftDepts.length + draftEmps.length === 0
      ? 'No people filter — dashboard shows the full org'
      : [
          draftDepts.length ? `${draftDepts.length} manager${draftDepts.length === 1 ? '' : 's'} (team scope)` : null,
          draftEmps.length ? `${draftEmps.length} employee${draftEmps.length === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  const listMaxH = embedded
    ? 'max-h-[min(52vh,22rem)] sm:max-h-[min(60vh,28rem)]'
    : 'max-h-[min(40vh,18rem)]';

  return (
    <div className="flex min-h-0 flex-col pb-2">
      <p className="text-[13px] leading-relaxed text-slate-600">
        Select <span className="font-medium text-slate-800">managers</span> (entire team) and/or{' '}
        <span className="font-medium text-slate-800">employees</span> (one mailbox each), then tap{' '}
        <span className="font-medium text-slate-800">Apply</span>.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-10">
        <div className="min-w-0">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Managers</p>
          {managerDepts.length === 0 ? (
            <p className="text-xs text-slate-400">Assign managers to departments to list them here.</p>
          ) : (
            <ul
              className={`space-y-1.5 overflow-y-auto overscroll-y-contain pr-0.5 [scrollbar-gutter:stable] ${listMaxH}`}
              aria-label="Managers"
            >
              {managerDepts.map((d) => {
                const checked = draftDeptSet.has(d.id);
                return (
                  <li key={d.id}>
                    <label className={rowWrap(checked)}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDraftDept(d.id)}
                        className={checkboxClass(checked)}
                        aria-label={`Manager ${managerLabel(d)}, team ${d.name}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-900">{managerLabel(d)}</span>
                        <span className="mt-0.5 block text-xs text-slate-500">{d.name}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Employees</p>
          {loadingEmployees ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : teammateRows.length === 0 ? (
            <p className="text-xs text-slate-400">No employee mailboxes yet.</p>
          ) : (
            <ul
              className={`space-y-1.5 overflow-y-auto overscroll-y-contain pr-0.5 [scrollbar-gutter:stable] ${listMaxH}`}
              aria-label="Employees"
            >
              {teammateRows.map((e) => {
                const checked = draftEmpSet.has(e.id);
                return (
                  <li key={e.id}>
                    <label className={rowWrap(checked)}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDraftEmp(e.id)}
                        className={checkboxClass(checked)}
                        aria-label={e.name}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-900">{e.name}</span>
                        {e.department_name && e.department_name !== '—' ? (
                          <span className="mt-0.5 block text-xs text-slate-500">{e.department_name}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 mt-6 border-t border-slate-100 bg-white pt-4">
        <p className="mb-3 text-center text-xs text-slate-500">{selectionSummary}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => onApply([...new Set(draftDepts)], [...new Set(draftEmps)])}
            className="flex-1 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:opacity-95"
          >
            Apply and open dashboard
          </button>
          <button
            type="button"
            onClick={clearDraft}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Clear selection
          </button>
        </div>
      </div>
    </div>
  );
}
