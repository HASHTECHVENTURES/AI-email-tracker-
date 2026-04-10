'use client';

import { useEffect, useRef, useState } from 'react';

type DeptRow = {
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
  /** When the panel opens, draft selections sync from the dashboard. */
  panelOpen: boolean;
  departmentOptions: DeptRow[];
  orgEmployees: CeoScopeOrgEmployee[];
  selectedDepartmentIds: string[];
  selectedEmployeeIds: string[];
  onApply: (departmentIds: string[], employeeIds: string[]) => void;
  loadingEmployees: boolean;
};

function managerLabel(d: DeptRow): string {
  return d.manager?.full_name?.trim() || d.manager?.email?.trim() || 'Manager';
}

function isManagerMailbox(emp: CeoScopeOrgEmployee, departments: DeptRow[]): boolean {
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
  panelOpen,
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

  useEffect(() => {
    if (panelOpen && !prevPanelOpen.current) {
      setDraftDepts([...selectedDepartmentIds]);
      setDraftEmps([...selectedEmployeeIds]);
    }
    prevPanelOpen.current = panelOpen;
  }, [panelOpen, selectedDepartmentIds, selectedEmployeeIds]);

  const draftDeptSet = new Set(draftDepts);
  const draftEmpSet = new Set(draftEmps);
  const companyWide = draftDepts.length === 0 && draftEmps.length === 0;

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
      ? 'Company-wide'
      : [
          draftDepts.length ? `${draftDepts.length} team${draftDepts.length === 1 ? '' : 's'}` : null,
          draftEmps.length ? `${draftEmps.length} teammate${draftEmps.length === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className="flex min-h-0 flex-col pb-2">
      <p className="text-[13px] leading-relaxed text-slate-600">
        Select <span className="font-medium text-slate-800">one or more</span> teams and/or teammates, then tap{' '}
        <span className="font-medium text-slate-800">Apply</span>. Managers = whole team; teammates = one mailbox each.
      </p>

      <label className={`mt-4 ${rowWrap(companyWide)}`}>
        <input
          type="checkbox"
          checked={companyWide}
          onChange={() => clearDraft()}
          className={checkboxClass(companyWide)}
          aria-label="Entire company"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">Entire company</span>
          <span className="mt-0.5 block text-xs text-slate-500">No team or people filter — executive view for everyone</span>
        </span>
      </label>

      <div className="mt-5">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Managers (teams)</p>
        {managerDepts.length === 0 ? (
          <p className="text-xs text-slate-400">Assign managers to departments to list them here.</p>
        ) : (
          <ul className="space-y-1.5" aria-label="Managers">
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
                      aria-label={`Team ${d.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-900">{managerLabel(d)}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">Team: {d.name}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-5">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Teammates</p>
        {loadingEmployees ? (
          <p className="text-xs text-slate-400">Loading…</p>
        ) : teammateRows.length === 0 ? (
          <p className="text-xs text-slate-400">No teammate mailboxes yet.</p>
        ) : (
          <ul
            className="max-h-[min(40vh,18rem)] space-y-1.5 overflow-y-auto overscroll-y-contain pr-0.5 [scrollbar-gutter:stable]"
            aria-label="Teammates"
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

      <div className="sticky bottom-0 mt-6 border-t border-slate-100 bg-white pt-4">
        <p className="mb-3 text-center text-xs text-slate-500">{selectionSummary}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => onApply([...new Set(draftDepts)], [...new Set(draftEmps)])}
            className="flex-1 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:opacity-95"
          >
            Apply to dashboard
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
