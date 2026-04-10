import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { TelegramService } from '../alerts/telegram.service';
import { EmailService } from '../email/email.service';
import { SettingsService } from '../settings/settings.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';
import type { EmployeeRole } from '../common/types';
import { RequestContext } from '../common/request-context';
import type { HistoricalSearchRunListItem } from '../self-tracking/self-tracking.service';
import { SelfTrackingService } from '../self-tracking/self-tracking.service';
import { EmployeesService } from '../employees/employees.service';

export interface GlobalMetrics {
  total_conversations: number;
  done: number;
  pending: number;
  missed: number;
  high_priority_missed: number;
  avg_delay_hours: number;
  alerts_sent: number;
  needs_attention: number;
  active: number;
  resolved: number;
  archived: number;
}

export interface EmployeePerformance {
  employee_id: string;
  employee_name: string;
  employee_email: string;
  total: number;
  done: number;
  pending: number;
  missed: number;
  avg_delay_hours: number;
}

export interface ConversationListItem {
  conversation_id: string;
  employee_id: string;
  employee_name: string;
  provider_thread_id: string;
  client_name: string | null;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  sla_hours: number;
  summary: string;
  short_reason: string;
  reason: string;
  last_client_msg_at: string | null;
  last_employee_reply_at: string | null;
  follow_up_required: boolean;
  confidence: number;
  lifecycle_status: string;
  manually_closed: boolean;
  is_ignored: boolean;
  /** You were only on Cc (not To) on the latest inbound — FYI bucket. */
  user_cc_only: boolean;
  open_gmail_link: string;
  /** ISO timestamp — used for "resolved today" style KPIs */
  updated_at: string;
}

interface ConversationDbRow {
  conversation_id: string;
  employee_id: string;
  provider_thread_id: string;
  client_name: string | null;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  summary: string;
  short_reason: string;
  reason: string;
  last_client_msg_at: string | null;
  last_employee_reply_at: string | null;
  follow_up_required: boolean;
  confidence: number;
  lifecycle_status: string;
  manually_closed: boolean;
  is_ignored: boolean;
  user_cc_only: boolean;
  updated_at: string;
}

export interface ConversationFilters {
  companyId: string;
  status?: string;
  employeeId?: string;
  /** When set (non-empty), restricts to these mailboxes; takes precedence over `employeeId`. */
  employeeIds?: string[];
  /** Single department (e.g. HEAD scope). */
  departmentId?: string;
  /** Multiple departments (CEO); OR of dept-tagged threads + team mailboxes in those depts. Takes precedence over `departmentId`. */
  departmentIds?: string[];
  priority?: string;
  lifecycle?: string;
}

export interface AiReport {
  generated_at: string;
  key_issues: string[];
  employee_insights: string[];
  patterns: string[];
  recommendation: string;
}

export interface AiReportArchiveItem extends AiReport {
  id: string;
  created_at: string;
}

/** CEO dashboard: per-department health with manager identity (no client PII). */
export interface CeoDepartmentRollup {
  department_id: string;
  department_name: string;
  manager_name: string | null;
  manager_email: string | null;
  total_threads: number;
  missed: number;
  pending: number;
  done: number;
  need_attention_count: number;
}

/** CEO dashboard: per-mailbox load for employees explicitly selected in command center scope (not the dept manager row). */
export interface CeoEmployeeMailboxRollup {
  employee_id: string;
  employee_name: string;
  department_name: string | null;
  total_threads: number;
  missed: number;
  pending: number;
  done: number;
  need_attention_count: number;
}

export interface SimplifiedDashboardResponse {
  needs_attention: ConversationListItem[];
  ai_insights: {
    /** @deprecated prefer structured fields */
    lines: string[];
    key_issues: string[];
    employee_insights: string[];
    patterns: string[];
    recommendation: string | null;
    last_updated_at: string | null;
  };
  conversations: ConversationListItem[];
  onboarding: {
    show: boolean;
    employee_count: number;
    mailboxes_connected: number;
    state: 'NO_EMPLOYEES' | 'GMAIL_PENDING' | 'WAITING_FOR_SYNC' | 'READY';
    employee_added: boolean;
    waiting_for_sync: boolean;
  };
  employee_filter_options: {
    id: string;
    name: string;
    department_name: string | null;
    is_manager: boolean;
  }[];
  my_followups?: { missed: number; pending: number; done: number };
  /** Populated for CEO only — department vs manager vs thread pressure. */
  ceo_department_rollups?: CeoDepartmentRollup[];
  /** CEO only — one row per mailbox picked under “Employees” in dashboard scope. */
  ceo_employee_mailbox_rollups?: CeoEmployeeMailboxRollup[];
  /** Recent saved Historical Search runs (My Email) visible to this user. */
  historical_search_runs?: HistoricalSearchRunListItem[];
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private readonly aiModel;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly telegramService: TelegramService,
    private readonly emailService: EmailService,
    private readonly settingsService: SettingsService,
    private readonly companyPolicyService: CompanyPolicyService,
    private readonly employeesService: EmployeesService,
    @Inject(forwardRef(() => SelfTrackingService))
    private readonly selfTrackingService: SelfTrackingService,
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey ?? '');
    this.aiModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash' });
  }

  async getGlobalMetrics(companyId: string, departmentId?: string): Promise<GlobalMetrics> {
    const { data: rpcData, error: rpcError } = await this.supabase.rpc('company_conversation_metrics', {
      p_company_id: companyId,
      p_department_id: departmentId ?? null,
    });
    if (!rpcError && rpcData && typeof rpcData === 'object') {
      const j = rpcData as Record<string, unknown>;
      const n = (k: string) => Number(j[k] ?? 0);
      return {
        total_conversations: n('total_conversations'),
        done: n('done'),
        pending: n('pending'),
        missed: n('missed'),
        high_priority_missed: n('high_priority_missed'),
        avg_delay_hours: Number(n('avg_delay_hours').toFixed(2)),
        alerts_sent: 0,
        needs_attention: n('needs_attention'),
        active: n('active'),
        resolved: n('resolved'),
        archived: n('archived'),
      };
    }
    if (rpcError) {
      this.logger.warn(`company_conversation_metrics RPC unavailable (${rpcError.message}), using row scan fallback`);
    }
    let q = this.supabase
      .from('conversations')
      .select('follow_up_status, priority, delay_hours, lifecycle_status', { count: 'exact' })
      .eq('company_id', companyId)
      .eq('is_ignored', false);
    if (departmentId) {
      q = q.eq('department_id', departmentId);
    }
    const { data, error } = await q;
    if (error) {
      this.logger.error('Failed to get global metrics', error.message);
      throw error;
    }
    const rows = (data ?? []) as Array<{
      follow_up_status: string;
      priority: string;
      delay_hours: number;
      lifecycle_status: string;
    }>;
    const total = rows.length;
    const done = rows.filter((r) => r.follow_up_status === 'DONE').length;
    const pending = rows.filter((r) => r.follow_up_status === 'PENDING').length;
    const missed = rows.filter((r) => r.follow_up_status === 'MISSED').length;
    const highPriorityMissed = rows.filter((r) => r.follow_up_status === 'MISSED' && r.priority === 'HIGH').length;
    const avgDelay = rows.length
      ? Number((rows.reduce((s, r) => s + Number(r.delay_hours ?? 0), 0) / rows.length).toFixed(2))
      : 0;
    const needsAttention = rows.filter((r) => r.lifecycle_status === 'NEEDS_ATTENTION').length;
    const active = rows.filter((r) => r.lifecycle_status === 'ACTIVE').length;
    const resolved = rows.filter((r) => r.lifecycle_status === 'RESOLVED').length;
    const archived = rows.filter((r) => r.lifecycle_status === 'ARCHIVED').length;
    return {
      total_conversations: total,
      done,
      pending,
      missed,
      high_priority_missed: highPriorityMissed,
      avg_delay_hours: avgDelay,
      alerts_sent: 0,
      needs_attention: needsAttention,
      active,
      resolved,
      archived,
    };
  }

  async getEmployeePerformance(companyId: string, departmentId?: string): Promise<EmployeePerformance[]> {
    let empQuery = this.supabase
      .from('employees')
      .select('id, name, email')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or('mailbox_type.is.null,mailbox_type.eq.TEAM');
    if (departmentId) {
      empQuery = empQuery.eq('department_id', departmentId);
    }
    const { data, error } = await empQuery;
    if (error) {
      this.logger.error('Failed to get employee performance', error.message);
      throw error;
    }
    const employees = (data ?? []) as Array<{ id: string; name: string; email: string }>;
    if (employees.length === 0) {
      return [];
    }

    const { expandedIds, aliasToTargetMap } = await this.employeesService.getEmployeeAliasMapping(
      companyId,
      employees.map((e) => e.id)
    );

    const convRows = await this.fetchConversationAggregatesForEmployeeIds(companyId, expandedIds);
    type Agg = { total: number; done: number; pending: number; missed: number; delaySum: number };
    const byEmp = new Map<string, Agg>();
    for (const e of employees) {
      byEmp.set(e.id, { total: 0, done: 0, pending: 0, missed: 0, delaySum: 0 });
    }
    for (const r of convRows) {
      const targetId = aliasToTargetMap.get(r.employee_id) ?? r.employee_id;
      const s = byEmp.get(targetId);
      if (!s) continue;
      s.total += 1;
      s.delaySum += Number(r.delay_hours ?? 0);
      if (r.follow_up_status === 'DONE') s.done += 1;
      else if (r.follow_up_status === 'PENDING') s.pending += 1;
      else if (r.follow_up_status === 'MISSED') s.missed += 1;
    }
    return employees.map((e) => {
      const s = byEmp.get(e.id)!;
      return {
        employee_id: e.id,
        employee_name: e.name,
        employee_email: e.email,
        total: s.total,
        done: s.done,
        pending: s.pending,
        missed: s.missed,
        avg_delay_hours: s.total ? Number((s.delaySum / s.total).toFixed(2)) : 0,
      };
    });
  }

  /** Minimal conversation rows for one or more mailboxes — batched to stay under PostgREST URL limits. */
  private async fetchConversationAggregatesForEmployeeIds(
    companyId: string,
    employeeIds: string[],
  ): Promise<Array<{ employee_id: string; follow_up_status: string; priority: string; delay_hours: number }>> {
    const chunkSize = 120;
    const out: Array<{ employee_id: string; follow_up_status: string; priority: string; delay_hours: number }> = [];
    for (let i = 0; i < employeeIds.length; i += chunkSize) {
      const slice = employeeIds.slice(i, i + chunkSize);
      const { data, error } = await this.supabase
        .from('conversations')
        .select('employee_id, follow_up_status, priority, delay_hours')
        .eq('company_id', companyId)
        .eq('is_ignored', false)
        .in('employee_id', slice);
      if (error) {
        this.logger.error('fetchConversationAggregatesForEmployeeIds', error.message);
        throw error;
      }
      out.push(...((data ?? []) as Array<{ employee_id: string; follow_up_status: string; priority: string; delay_hours: number }>));
    }
    return out;
  }

  /**
   * CEO picked both department(s) and extra employee mailboxes — union thread lists (not intersection).
   */
  private async mergeCeoScopedConversations(
    companyId: string,
    filters: { status?: string; priority?: string } | undefined,
    departmentIds: string[],
    employeeIds: string[],
  ): Promise<ConversationListItem[]> {
    const [byDept, byEmp] = await Promise.all([
      this.getConversationsList({
        companyId,
        departmentIds,
        status: filters?.status,
        priority: filters?.priority,
      }),
      this.getConversationsList({
        companyId,
        employeeIds,
        status: filters?.status,
        priority: filters?.priority,
      }),
    ]);
    const seen = new Set<string>();
    const out: ConversationListItem[] = [];
    for (const c of [...byDept, ...byEmp]) {
      if (seen.has(c.conversation_id)) continue;
      seen.add(c.conversation_id);
      out.push(c);
    }
    out.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return out;
  }

  private static needsAttentionConv(c: ConversationListItem): boolean {
    return c.follow_up_status === 'MISSED' || (c.priority === 'HIGH' && c.follow_up_status !== 'DONE');
  }

  /**
   * People picked as mailboxes in CEO scope — distinct from department “team lead” rows.
   */
  private async buildCeoEmployeeMailboxRollups(
    companyId: string,
    all: ConversationListItem[],
    selectedEmployeeIds: string[],
  ): Promise<CeoEmployeeMailboxRollup[]> {
    if (!selectedEmployeeIds.length) return [];
    const { aliasToTargetMap } = await this.employeesService.getEmployeeAliasMapping(
      companyId,
      selectedEmployeeIds,
    );
    const canonFor = (eid: string) => aliasToTargetMap.get(eid) ?? eid;
    const uniqueCanon = [...new Set(selectedEmployeeIds.map(canonFor))];

    const { data: emps, error: eErr } = await this.supabase
      .from('employees')
      .select('id, name, department_id')
      .eq('company_id', companyId)
      .in('id', uniqueCanon);
    if (eErr) {
      this.logger.warn(`buildCeoEmployeeMailboxRollups employees: ${eErr.message}`);
    }
    const empById = new Map((emps ?? []).map((e: { id: string; name: string; department_id: string | null }) => [e.id, e]));

    const { data: deptRows } = await this.supabase
      .from('departments')
      .select('id, name')
      .eq('company_id', companyId);
    const deptName = new Map((deptRows ?? []).map((d: { id: string; name: string }) => [d.id, d.name]));

    const rows: CeoEmployeeMailboxRollup[] = [];
    for (const canon of uniqueCanon) {
      const convs = all.filter((c) => canonFor(c.employee_id) === canon);
      const em = empById.get(canon);
      const dn = em?.department_id ? deptName.get(em.department_id) ?? null : null;
      let missed = 0;
      let pending = 0;
      let done = 0;
      let need_attention_count = 0;
      for (const c of convs) {
        if (c.follow_up_status === 'MISSED') missed++;
        else if (c.follow_up_status === 'PENDING') pending++;
        else if (c.follow_up_status === 'DONE') done++;
        if (DashboardService.needsAttentionConv(c)) need_attention_count++;
      }
      rows.push({
        employee_id: canon,
        employee_name: em?.name?.trim() || convs[0]?.employee_name?.trim() || 'Mailbox',
        department_name: dn,
        total_threads: convs.length,
        missed,
        pending,
        done,
        need_attention_count,
      });
    }
    return rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  }

  async getConversationsList(filters: ConversationFilters): Promise<ConversationListItem[]> {
    let query = this.supabase
      .from('conversations')
      .select(
        'conversation_id, employee_id, company_id, department_id, provider_thread_id, client_name, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored, user_cc_only, updated_at',
      )
      .eq('company_id', filters.companyId)
      .eq('is_ignored', false)
      .order('updated_at', { ascending: false });

    if (filters.departmentIds && filters.departmentIds.length > 0) {
      const deptIds = filters.departmentIds;
      const allEmpNested = await Promise.all(
        deptIds.map((d) => this.getEmployeeIdsInDepartment(filters.companyId, d)),
      );
      const uniqEmp = [...new Set(allEmpNested.flat())];
      if (uniqEmp.length > 0) {
        query = query.or(`department_id.in.(${deptIds.join(',')}),employee_id.in.(${uniqEmp.join(',')})`);
      } else {
        query = query.in('department_id', deptIds);
      }
    } else if (filters.departmentId) {
      const inDept = await this.getEmployeeIdsInDepartment(filters.companyId, filters.departmentId);
      if (inDept.length > 0) {
        query = query.or(
          `department_id.eq.${filters.departmentId},employee_id.in.(${inDept.join(',')})`,
        );
      } else {
        query = query.eq('department_id', filters.departmentId);
      }
    }
    
    let aliasToTargetMap = new Map<string, string>();
    let effectiveEmployeeIds: string[] | undefined;

    if (filters.employeeIds && filters.employeeIds.length > 0) {
      const res = await this.employeesService.getEmployeeAliasMapping(filters.companyId, filters.employeeIds);
      effectiveEmployeeIds = res.expandedIds;
      aliasToTargetMap = res.aliasToTargetMap;
    } else if (filters.employeeId) {
      const res = await this.employeesService.getEmployeeAliasMapping(filters.companyId, [filters.employeeId]);
      effectiveEmployeeIds = res.expandedIds;
      aliasToTargetMap = res.aliasToTargetMap;
    }

    if (filters.status) query = query.eq('follow_up_status', filters.status);
    if (effectiveEmployeeIds && effectiveEmployeeIds.length > 0) {
      query = query.in('employee_id', effectiveEmployeeIds);
    }
    if (filters.priority) query = query.eq('priority', filters.priority);
    if (filters.lifecycle) query = query.eq('lifecycle_status', filters.lifecycle);
    const { data, error } = await query;

    if (error) {
      this.logger.error('Failed to get conversations list', error.message);
      throw error;
    }
    const rows = (data ?? []) as ConversationDbRow[];
    const ids = [...new Set(rows.map((r) => r.employee_id))];
    const { data: employees } = await this.supabase
      .from('employees')
      .select('id, name, sla_hours_default')
      .in('id', ids);
    const employeeById = new Map(
      (employees ?? []).map(
        (e: { id: string; name: string; sla_hours_default: number | null }) => [e.id, e],
      ),
    );
    const defaultSla = await this.getDefaultSlaHours();
    return rows.map((r) => {
      const targetId = aliasToTargetMap.get(r.employee_id) ?? r.employee_id;
      const tid = encodeURIComponent(r.provider_thread_id);
      const emp = employeeById.get(targetId);
      return {
        conversation_id: r.conversation_id,
        employee_id: targetId,
        employee_name: emp?.name ?? targetId,
        provider_thread_id: r.provider_thread_id,
        client_name: r.client_name,
        client_email: r.client_email,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
        delay_hours: r.delay_hours,
        sla_hours: emp?.sla_hours_default ?? defaultSla,
        summary: r.summary,
        short_reason: r.short_reason,
        reason: r.reason || r.short_reason,
        last_client_msg_at: r.last_client_msg_at,
        last_employee_reply_at: r.last_employee_reply_at,
        follow_up_required: r.follow_up_required,
        confidence: r.confidence,
        lifecycle_status: r.lifecycle_status,
        manually_closed: r.manually_closed,
        is_ignored: r.is_ignored,
        user_cc_only: r.user_cc_only ?? false,
        open_gmail_link: `https://mail.google.com/mail/u/0/#inbox/${tid}`,
        updated_at: r.updated_at,
      };
    });
  }

  /** Executive = company-wide CEO; department = manager’s team only. */
  async generateAiReport(
    companyId: string,
    options?: {
      force?: boolean;
      minCooldownMs?: number;
      scope?: 'EXECUTIVE' | 'DEPARTMENT_HEAD';
      departmentId?: string;
    },
  ): Promise<AiReport> {
    const force = options?.force === true;
    const minCooldownMs = force ? 0 : (options?.minCooldownMs ?? 3600_000);
    const scope = options?.scope ?? 'EXECUTIVE';
    const departmentId = options?.departmentId;

    const fallback: AiReport = {
      generated_at: new Date().toISOString(),
      key_issues: ['Unable to generate AI report — check GEMINI_API_KEY'],
      employee_insights: [],
      patterns: [],
      recommendation: '',
    };

    const sys = await this.settingsService.getAll();
    if (!sys.ai_enabled) {
      return {
        generated_at: new Date().toISOString(),
        key_issues: ['AI operations are off in Settings (CEO). Turn them on to generate reports.'],
        employee_insights: [],
        patterns: [],
        recommendation: '',
      };
    }

    const companyAiOn = await this.companyPolicyService.isAiEnabledForCompany(companyId);
    if (!companyAiOn) {
      return {
        generated_at: new Date().toISOString(),
        key_issues: ['AI is disabled for this organization by the platform administrator.'],
        employee_insights: [],
        patterns: [],
        recommendation: '',
      };
    }

    if (scope === 'DEPARTMENT_HEAD' && !sys.ai_for_managers_enabled) {
      return {
        generated_at: new Date().toISOString(),
        key_issues: ['AI for department managers is off in Settings (CEO).'],
        employee_insights: [],
        patterns: [],
        recommendation: '',
      };
    }

    if (!process.env.GEMINI_API_KEY) return fallback;

    if (scope === 'DEPARTMENT_HEAD' && !departmentId) {
      this.logger.warn('generateAiReport: DEPARTMENT_HEAD requires departmentId');
      return fallback;
    }

    if (minCooldownMs > 0) {
      const existing = await this.getLastAiReport(companyId, { scope, departmentId });
      if (existing?.generated_at) {
        const ageMs = Date.now() - new Date(existing.generated_at).getTime();
        if (ageMs < minCooldownMs) {
          this.logger.debug(
            `Skipping AI report (${scope}) — last generated ${Math.round(ageMs / 60_000)}m ago (cooldown: ${Math.round(minCooldownMs / 60_000)}m)`,
          );
          return existing;
        }
      }
    }

    const deptFilter = scope === 'DEPARTMENT_HEAD' ? departmentId : undefined;

    try {
      const metrics = await this.getGlobalMetrics(companyId, deptFilter);
      const employees = await this.getEmployeePerformance(companyId, deptFilter);
      const attentionFilters: ConversationFilters = {
        companyId,
        lifecycle: 'NEEDS_ATTENTION',
      };
      if (deptFilter) attentionFilters.departmentId = deptFilter;
      const attention = await this.getConversationsList(attentionFilters);

      let dataBlock: string;
      let prompt: string;

      if (scope === 'EXECUTIVE') {
        const attentionAnon = attention.slice(0, 12).map((c) => ({
          priority: c.priority,
          status: c.follow_up_status,
          delay_hours: Number(Number(c.delay_hours).toFixed(1)),
          lifecycle: c.lifecycle_status,
        }));
        dataBlock = [
          `Org metrics (all teams): ${JSON.stringify(metrics)}`,
          `Team load summary (names only, no client PII): ${JSON.stringify(
            employees.map((e) => ({
              team_member: e.employee_name,
              threads: e.total,
              missed: e.missed,
              pending: e.pending,
              avg_delay_h: e.avg_delay_hours,
            })),
          )}`,
          `Needs-attention threads (counts only, no client emails): ${JSON.stringify(attentionAnon)}`,
        ].join('\n');

        prompt = `You are an executive / CEO analyst for company-wide follow-up health.
The input intentionally excludes external client email addresses and message content.
Return ONLY valid JSON (no markdown):

{
  "key_issues": ["up to 3 bullets: strategic or org-wide risks and SLA exposure"],
  "employee_insights": ["up to 2 bullets: cross-team performance themes — you may refer to internal employee names from the data"],
  "patterns": ["up to 2 bullets: trends across the organization"],
  "recommendation": "one sentence strategic recommendation for leadership"
}

Tone: board-level, concise. Do NOT invent client or sender identities.
Keep each bullet under 18 words.

--- DATA ---
${dataBlock}`;
      } else {
        const teamMailboxRows = employees.map((e) => ({
          employee_id: e.employee_id,
          name: e.employee_name,
          email: e.employee_email,
          total: e.total,
          missed: e.missed,
          pending: e.pending,
          avg_delay: e.avg_delay_hours,
        }));
        const canonicalNames = employees.map((e) => e.employee_name).filter((n) => n.trim().length > 0);
        dataBlock = [
          `Department metrics: ${JSON.stringify(metrics)}`,
          `Team mailboxes (authoritative spellings for people on this team): ${JSON.stringify(teamMailboxRows)}`,
          `canonical_team_names_only: ${JSON.stringify(canonicalNames)}`,
          `Needs attention (${attention.length}) — use assigned_to / employee_id only for names; short_reason text is omitted because it may contain errors: ${JSON.stringify(
            attention.slice(0, 12).map((c) => ({
              employee_id: c.employee_id,
              assigned_to: c.employee_name,
              client: c.client_email,
              status: c.follow_up_status,
              priority: c.priority,
              delay_hours: Number(Number(c.delay_hours).toFixed(2)),
            })),
          )}`,
        ].join('\n');

        prompt = `You are a department manager's AI assistant for follow-up monitoring.
Focus ONLY on this department's team and their live threads. Be practical and actionable.
Return ONLY valid JSON (no markdown):

{
  "key_issues": ["up to 3 bullets: urgent team or client follow-up issues"],
  "employee_insights": ["up to 3 bullets: coaching-style notes — name people when helpful"],
  "patterns": ["up to 2 bullets: what this team repeats or struggles with"],
  "recommendation": "one sentence next step for the manager"
}

Keep bullets under 20 words.

STRICT RULES FOR NAMES:
- The ONLY valid internal teammate names are the strings in JSON key "canonical_team_names_only" and the "name" / "assigned_to" fields in the data above. Copy spelling and capitalization EXACTLY (e.g. "josh" stays "josh").
- Do NOT invent, substitute, or "normalize" names (no "John" if the data says "josh"). Do NOT use placeholder names.
- If you mention a teammate, they MUST appear in canonical_team_names_only or as assigned_to for a row.

--- DATA ---
${dataBlock}`;
      }

      const result = await this.aiModel.generateContent(prompt);
      const text = result.response
        .text()
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

      const parsed = JSON.parse(text);

      const report: AiReport = {
        generated_at: new Date().toISOString(),
        key_issues: Array.isArray(parsed.key_issues) ? parsed.key_issues.slice(0, 4) : [],
        employee_insights: Array.isArray(parsed.employee_insights) ? parsed.employee_insights.slice(0, 4) : [],
        patterns: Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 3) : [],
        recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation.slice(0, 280) : '',
      };

      const insertRow: Record<string, unknown> = {
        company_id: companyId,
        content: report,
        created_at: report.generated_at,
        report_scope: scope,
      };
      if (scope === 'DEPARTMENT_HEAD' && departmentId) {
        insertRow.department_id = departmentId;
      } else {
        insertRow.department_id = null;
      }

      await this.supabase.from('dashboard_reports').insert(insertRow);

      const settingsKey =
        scope === 'DEPARTMENT_HEAD' && departmentId
          ? `last_ai_report_at_${companyId}_dept_${departmentId}`
          : `last_ai_report_at_${companyId}`;
      await this.supabase.from('system_settings').upsert(
        {
          key: settingsKey,
          value: report.generated_at,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' },
      );

      if (scope === 'EXECUTIVE') {
        if (this.telegramService.isConfigured()) {
          this.telegramService.sendAiReport(report).catch((err) => {
            this.logger.warn(`Failed to send AI report to Telegram: ${(err as Error).message}`);
          });
        }

        void this.emailService.maybeSendReportAfterGeneration(companyId, report, {
          total: metrics.total_conversations,
          pending: metrics.pending,
          missed: metrics.missed,
          avg_delay: metrics.avg_delay_hours,
        });
      }

      return report;
    } catch (err) {
      this.logger.error('AI report generation failed', (err as Error).message);
      return fallback;
    }
  }

  async getLastAiReport(
    companyId: string,
    opts?: { scope?: 'EXECUTIVE' | 'DEPARTMENT_HEAD'; departmentId?: string | null },
  ): Promise<AiReport | null> {
    const scope = opts?.scope ?? 'EXECUTIVE';
    let q = this.supabase
      .from('dashboard_reports')
      .select('content, created_at, report_scope, department_id')
      .eq('company_id', companyId);

    if (scope === 'DEPARTMENT_HEAD') {
      if (!opts?.departmentId) return null;
      q = q.eq('report_scope', scope).eq('department_id', opts.departmentId);
    } else {
      q = q
        .is('department_id', null)
        .or('report_scope.eq.EXECUTIVE,report_scope.is.null');
    }

    const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (error) {
      this.logger.warn(`getLastAiReport (${scope}): ${error.message}`);
      if (scope !== 'EXECUTIVE') {
        return null;
      }
      const { data: legacy } = await this.supabase
        .from('dashboard_reports')
        .select('content, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!legacy) return null;
      try {
        return (legacy as { content: AiReport }).content;
      } catch {
        return null;
      }
    }

    if (!data) return null;
    try {
      return (data as { content: AiReport }).content;
    } catch {
      return null;
    }
  }

  async getAiReportArchive(
    companyId: string,
    limit = 50,
    opts?: { scope?: 'EXECUTIVE' | 'DEPARTMENT_HEAD'; departmentId?: string | null },
  ): Promise<AiReportArchiveItem[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const scope = opts?.scope ?? 'EXECUTIVE';

    let q = this.supabase
      .from('dashboard_reports')
      .select('id, content, created_at, report_scope, department_id')
      .eq('company_id', companyId);

    if (scope === 'DEPARTMENT_HEAD') {
      if (!opts?.departmentId) return [];
      q = q.eq('report_scope', scope).eq('department_id', opts.departmentId);
    } else {
      q = q
        .is('department_id', null)
        .or('report_scope.eq.EXECUTIVE,report_scope.is.null');
    }

    const { data, error } = await q.order('created_at', { ascending: false }).limit(safeLimit);

    if (error) {
      this.logger.error('Failed to load AI report archive', error.message);
      if (scope === 'DEPARTMENT_HEAD') {
        return [];
      }
      // Pre-migration DBs only have id, company_id, content, created_at — scoped columns are missing.
      const { data: legacy, error: legacyErr } = await this.supabase
        .from('dashboard_reports')
        .select('id, content, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(safeLimit);
      if (legacyErr) {
        this.logger.error('Failed to load AI report archive (legacy fallback)', legacyErr.message);
        return [];
      }
      const rows = (legacy ?? []) as Array<{
        id: string;
        content: Partial<AiReport> | null;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        generated_at: r.content?.generated_at ?? r.created_at,
        key_issues: Array.isArray(r.content?.key_issues) ? r.content!.key_issues!.slice(0, 6) : [],
        employee_insights: Array.isArray(r.content?.employee_insights)
          ? r.content!.employee_insights!.slice(0, 6)
          : [],
        patterns: Array.isArray(r.content?.patterns) ? r.content!.patterns!.slice(0, 6) : [],
        recommendation: typeof r.content?.recommendation === 'string' ? r.content.recommendation : '',
      }));
    }

    const rows = (data ?? []) as Array<{
      id: string;
      content: Partial<AiReport> | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      generated_at: r.content?.generated_at ?? r.created_at,
      key_issues: Array.isArray(r.content?.key_issues) ? r.content!.key_issues!.slice(0, 6) : [],
      employee_insights: Array.isArray(r.content?.employee_insights)
        ? r.content!.employee_insights!.slice(0, 6)
        : [],
      patterns: Array.isArray(r.content?.patterns) ? r.content!.patterns!.slice(0, 6) : [],
      recommendation: typeof r.content?.recommendation === 'string' ? r.content.recommendation : '',
    }));
  }

  /** CEO: delete one executive archived report. */
  async deleteExecutiveAiReport(companyId: string, reportId: string): Promise<boolean> {
    const id = reportId.trim();
    // Accept any hyphenated 128-bit UUID string (Postgres/Supabase may emit v4, v7, etc.).
    const uuidLoose = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidLoose.test(id)) {
      this.logger.warn(`deleteExecutiveAiReport: rejected id format (len=${id.length})`);
      return false;
    }

    // Company-wide (CEO) reports always use department_id = NULL; scoped manager reports set department_id.
    // Do not require report_scope here so deletes stay aligned with listed rows if scope values differ in legacy data.
    const { data, error } = await this.supabase
      .from('dashboard_reports')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)
      .is('department_id', null)
      .select('id');

    if (error) {
      this.logger.error('deleteExecutiveAiReport', error.message);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  /**
   * Aggregates conversations by department with HEAD manager from `users`.
   * Used on the CEO dashboard for org-wide graphs (no client emails).
   *
   * Effective department = conversation.department_id ?? employee.department_id (threads often only set on employee).
   * Emits one rollup per bucket that has threads (including unknown UUIDs and unassigned).
   * @param filterDepartmentIds When set (CEO scope), rollups only include these departments’ effective buckets.
   * @param filterEmployeeIds When set, only threads owned by these employee row ids.
   */
  async getCeoDepartmentRollups(
    companyId: string,
    filterDepartmentIds?: string[],
    filterEmployeeIds?: string[],
  ): Promise<CeoDepartmentRollup[]> {
    const { data: convoRows, error: cErr } = await this.supabase
      .from('conversations')
      .select('conversation_id, department_id, employee_id, follow_up_status, priority')
      .eq('company_id', companyId)
      .eq('is_ignored', false);
    if (cErr) {
      this.logger.warn(`getCeoDepartmentRollups conversations: ${cErr.message}`);
      return [];
    }

    type RawAggRow = {
      conversation_id: string;
      department_id: string | null;
      employee_id: string;
      follow_up_status: string;
      priority: string;
    };

    let raw = (convoRows ?? []) as RawAggRow[];

    const normDept = (d: string | null | undefined): string | null => {
      if (d == null) return null;
      const s = String(d).trim();
      return s.length ? s : null;
    };

    const empIds = [...new Set(raw.map((r) => r.employee_id))];
    let empDeptById = new Map<string, string | null>();
    if (empIds.length > 0) {
      const { data: emps, error: eErr } = await this.supabase
        .from('employees')
        .select('id, department_id')
        .eq('company_id', companyId)
        .in('id', empIds);
      if (eErr) {
        this.logger.warn(`getCeoDepartmentRollups employees: ${eErr.message}`);
      } else {
        empDeptById = new Map((emps ?? []).map((e: { id: string; department_id: string | null }) => [e.id, e.department_id]));
      }
    }

    const deptFilterFn = (r: RawAggRow, allowDept: Set<string>): boolean => {
      const fromConv = normDept(r.department_id);
      const fromEmp = normDept(empDeptById.get(r.employee_id) ?? null);
      const eff = fromConv ?? fromEmp ?? null;
      return eff != null && allowDept.has(eff);
    };

    /**
     * Manager scope + employee scope together means UNION (team OR selected mailboxes), not intersection.
     */
    if (filterDepartmentIds?.length && filterEmployeeIds?.length) {
      const allowDept = new Set(filterDepartmentIds);
      const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(companyId, filterEmployeeIds);
      const allowEmp = new Set(expandedIds);
      const byDept = raw.filter((r) => deptFilterFn(r, allowDept));
      const byEmp = raw.filter((r) => allowEmp.has(r.employee_id));
      const seen = new Set<string>();
      raw = [];
      for (const row of [...byDept, ...byEmp]) {
        if (seen.has(row.conversation_id)) continue;
        seen.add(row.conversation_id);
        raw.push(row);
      }
    } else if (filterDepartmentIds && filterDepartmentIds.length > 0) {
      const allowDept = new Set(filterDepartmentIds);
      raw = raw.filter((r) => deptFilterFn(r, allowDept));
    } else if (filterEmployeeIds && filterEmployeeIds.length > 0) {
      const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(companyId, filterEmployeeIds);
      const allow = new Set(expandedIds);
      raw = raw.filter((r) => allow.has(r.employee_id));
    }

    type Row = { department_id: string | null; follow_up_status: string; priority: string };
    const rows: Row[] = raw.map((r) => {
      const fromConv = normDept(r.department_id);
      const fromEmp = normDept(empDeptById.get(r.employee_id) ?? null);
      const eff = fromConv ?? fromEmp ?? null;
      return {
        department_id: eff,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
      };
    });

    const needsAttentionRow = (c: Row) =>
      c.follow_up_status === 'MISSED' || (c.priority === 'HIGH' && c.follow_up_status !== 'DONE');

    const byDept = new Map<string, Row[]>();
    for (const c of rows) {
      const key = c.department_id ?? '___unassigned___';
      if (!byDept.has(key)) byDept.set(key, []);
      byDept.get(key)!.push(c);
    }

    const { data: heads } = await this.supabase
      .from('users')
      .select('department_id, full_name, email')
      .eq('company_id', companyId)
      .eq('role', 'HEAD');
    const headByDept = new Map<string, { full_name: string | null; email: string }>();
    for (const h of heads ?? []) {
      const did = (h as { department_id: string | null }).department_id;
      if (did) {
        headByDept.set(did, h as { full_name: string | null; email: string });
      }
    }
    const { data: mems, error: memHeadErr } = await this.supabase
      .from('manager_department_memberships')
      .select('department_id, user_id')
      .eq('company_id', companyId);
    if (!memHeadErr && mems?.length) {
      const uids = [...new Set((mems as { user_id: string }[]).map((m) => m.user_id))];
      const { data: urows } = await this.supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', uids);
      const userMap = new Map(
        (urows ?? []).map((u: { id: string; full_name: string | null; email: string }) => [u.id, u]),
      );
      for (const m of mems as { department_id: string; user_id: string }[]) {
        if (!headByDept.has(m.department_id)) {
          const u = userMap.get(m.user_id);
          if (u) {
            headByDept.set(m.department_id, { full_name: u.full_name, email: u.email });
          }
        }
      }
    }

    const { data: allDepts } = await this.supabase
      .from('departments')
      .select('id, name')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    const deptNameById = new Map((allDepts ?? []).map((d: { id: string; name: string }) => [d.id, d.name]));
    const allDeptRows = (allDepts ?? []) as { id: string; name: string }[];

    const rollupDeptIds = [...byDept.keys()].filter((k) => k !== '___unassigned___') as string[];
    const missingNames = rollupDeptIds.filter((id) => !deptNameById.has(id));
    if (missingNames.length > 0) {
      const { data: extra } = await this.supabase
        .from('departments')
        .select('id, name')
        .eq('company_id', companyId)
        .in('id', missingNames);
      for (const d of extra ?? []) {
        deptNameById.set(d.id, d.name);
      }
    }

    const rollups: CeoDepartmentRollup[] = [];
    const knownDeptId = new Set(allDeptRows.map((d) => d.id));

    const deptRowsForRollup =
      filterDepartmentIds && filterDepartmentIds.length > 0
        ? allDeptRows.filter((d) => filterDepartmentIds.includes(d.id))
        : allDeptRows;

    /** Every department in the org directory — include zeros so CEO always sees department + manager columns. */
    for (const d of deptRowsForRollup) {
      const list = byDept.get(d.id) ?? [];
      const missed = list.filter((x) => x.follow_up_status === 'MISSED').length;
      const pending = list.filter((x) => x.follow_up_status === 'PENDING').length;
      const done = list.filter((x) => x.follow_up_status === 'DONE').length;
      const need_attention_count = list.filter(needsAttentionRow).length;
      const head = headByDept.get(d.id);
      rollups.push({
        department_id: d.id,
        department_name: d.name,
        manager_name: head?.full_name?.trim() || null,
        manager_email: head?.email ?? null,
        total_threads: list.length,
        missed,
        pending,
        done,
        need_attention_count,
      });
    }

    /** Conversation buckets whose department_id is not in `departments` (legacy / sync drift). */
    if (filterDepartmentIds && filterDepartmentIds.length > 0) {
      return rollups.sort((a, b) => {
        if (b.need_attention_count !== a.need_attention_count) return b.need_attention_count - a.need_attention_count;
        if (b.missed !== a.missed) return b.missed - a.missed;
        return a.department_name.localeCompare(b.department_name);
      });
    }

    for (const id of rollupDeptIds) {
      if (knownDeptId.has(id)) continue;
      const list = byDept.get(id) ?? [];
      if (list.length === 0) continue;
      const missed = list.filter((x) => x.follow_up_status === 'MISSED').length;
      const pending = list.filter((x) => x.follow_up_status === 'PENDING').length;
      const done = list.filter((x) => x.follow_up_status === 'DONE').length;
      const need_attention_count = list.filter(needsAttentionRow).length;
      const head = headByDept.get(id);
      const name = deptNameById.get(id) ?? 'Unknown department';
      rollups.push({
        department_id: id,
        department_name: name,
        manager_name: head?.full_name?.trim() || null,
        manager_email: head?.email ?? null,
        total_threads: list.length,
        missed,
        pending,
        done,
        need_attention_count,
      });
    }

    const orphan = byDept.get('___unassigned___') ?? [];
    if (orphan.length > 0) {
      const missed = orphan.filter((x) => x.follow_up_status === 'MISSED').length;
      const pending = orphan.filter((x) => x.follow_up_status === 'PENDING').length;
      const done = orphan.filter((x) => x.follow_up_status === 'DONE').length;
      const need_attention_count = orphan.filter(needsAttentionRow).length;
      rollups.push({
        department_id: 'unassigned',
        department_name: 'Unassigned (no department)',
        manager_name: null,
        manager_email: null,
        total_threads: orphan.length,
        missed,
        pending,
        done,
        need_attention_count,
      });
    }

    return rollups.sort((a, b) => {
      if (b.need_attention_count !== a.need_attention_count) return b.need_attention_count - a.need_attention_count;
      if (b.missed !== a.missed) return b.missed - a.missed;
      return a.department_name.localeCompare(b.department_name);
    });
  }

  async getDashboard(
    companyId: string,
    scope: { departmentId?: string; employeeId?: string; role: EmployeeRole; userId?: string },
    filters?: {
      status?: string;
      employeeId?: string;
      employeeIds?: string[];
      priority?: string;
      /** Legacy CEO single-department query param. */
      departmentId?: string;
      departmentIds?: string[];
    },
    actorEmail?: string,
  ): Promise<SimplifiedDashboardResponse> {
    const scopedEmployeeId = scope.role === 'EMPLOYEE' ? scope.employeeId : undefined;
    const ceoEmployeeIds =
      scope.role === 'CEO' && filters?.employeeIds && filters.employeeIds.length > 0
        ? filters.employeeIds
        : undefined;
    const filterEmployee =
      ceoEmployeeIds && scope.role === 'CEO'
        ? undefined
        : scope.role === 'EMPLOYEE'
          ? scopedEmployeeId
          : filters?.employeeId ?? scopedEmployeeId;

    const ceoDeptIdsRaw =
      scope.role === 'CEO' && filters?.departmentIds && filters.departmentIds.length > 0
        ? filters.departmentIds
        : scope.role === 'CEO' && filters?.departmentId?.trim()
          ? [filters.departmentId.trim()]
          : undefined;

    const scopedDepartmentIdHead = scope.role === 'HEAD' ? scope.departmentId : undefined;

    const reportPromise =
      scope.role === 'CEO' ? this.getLastAiReport(companyId, { scope: 'EXECUTIVE' }) : Promise.resolve(null);

    const rollupsPromise =
      scope.role === 'CEO'
        ? this.getCeoDepartmentRollups(companyId, ceoDeptIdsRaw, ceoEmployeeIds)
        : Promise.resolve(undefined);

    const ceoUnionDeptAndEmployees =
      scope.role === 'CEO' &&
      Boolean(ceoDeptIdsRaw?.length) &&
      Boolean(ceoEmployeeIds?.length);

    const conversationsPromise = ceoUnionDeptAndEmployees
      ? this.mergeCeoScopedConversations(companyId, filters, ceoDeptIdsRaw!, ceoEmployeeIds!)
      : this.getConversationsList({
          companyId,
          departmentId: scopedDepartmentIdHead,
          departmentIds: scope.role === 'CEO' ? ceoDeptIdsRaw : undefined,
          employeeId: filterEmployee,
          employeeIds: ceoEmployeeIds,
          status: filters?.status,
          priority: filters?.priority,
        });

    const [report, all, onboarding, employeeFilterOptions, ceo_department_rollups, actorEmployeeId] = await Promise.all([
      reportPromise,
      conversationsPromise,
      this.getOnboardingSnapshot(companyId),
      scope.role === 'EMPLOYEE'
        ? Promise.resolve(
            [] as {
              id: string;
              name: string;
              department_name: string | null;
              is_manager: boolean;
            }[],
          )
        : this.getEmployeeFilterOptions(
            companyId,
            undefined,
            scope.role === 'CEO' ? ceoDeptIdsRaw : undefined,
            scope.role === 'CEO' ? ceoEmployeeIds : undefined,
          ),
      rollupsPromise,
      scope.role === 'EMPLOYEE' || !actorEmail
        ? Promise.resolve<string | null>(null)
        : this.getEmployeeIdByEmail(companyId, actorEmail),
    ]);

    const visibleConversations = actorEmployeeId
      ? all.filter((c) => c.employee_id !== actorEmployeeId)
      : all;
    const visibleEmployeeFilterOptions = actorEmployeeId
      ? employeeFilterOptions.filter((o) => o.id !== actorEmployeeId)
      : employeeFilterOptions;

    const attentionCap = scope.role === 'HEAD' ? 50 : scope.role === 'CEO' ? 40 : 5;
    const needs_attention = visibleConversations
      .filter(
        (c) =>
          c.follow_up_status === 'MISSED' ||
          (c.priority === 'HIGH' && c.follow_up_status !== 'DONE'),
      )
      .slice(0, attentionCap);

    const keyIssues = scope.role === 'EMPLOYEE' ? [] : (report?.key_issues ?? []);
    const employeeInsights = scope.role === 'EMPLOYEE' ? [] : (report?.employee_insights ?? []);
    const patterns = scope.role === 'EMPLOYEE' ? [] : (report?.patterns ?? []);
    const recommendation = scope.role === 'EMPLOYEE' ? null : (report?.recommendation?.trim() || null);
    const insightLines = [...keyIssues, ...employeeInsights, ...patterns];

    const out: SimplifiedDashboardResponse = {
      needs_attention,
      ai_insights: {
        lines: insightLines,
        key_issues: keyIssues,
        employee_insights: employeeInsights,
        patterns,
        recommendation,
        last_updated_at: scope.role === 'EMPLOYEE' ? null : (report?.generated_at ?? null),
      },
      conversations: visibleConversations,
      onboarding,
      employee_filter_options: visibleEmployeeFilterOptions,
    };

    if (scope.role === 'CEO') {
      out.ceo_department_rollups = ceo_department_rollups ?? [];
      if (ceoEmployeeIds?.length) {
        out.ceo_employee_mailbox_rollups = await this.buildCeoEmployeeMailboxRollups(
          companyId,
          all,
          ceoEmployeeIds,
        );
      }
    }

    if (scope.role === 'EMPLOYEE' && scope.employeeId) {
      out.my_followups = {
        missed: visibleConversations.filter((c) => c.follow_up_status === 'MISSED').length,
        pending: visibleConversations.filter((c) => c.follow_up_status === 'PENDING').length,
        done: visibleConversations.filter((c) => c.follow_up_status === 'DONE').length,
      };
    }

    if (
      actorEmail &&
      (scope.role === 'CEO' || scope.role === 'HEAD' || scope.role === 'EMPLOYEE')
    ) {
      const ctx: RequestContext = {
        companyId,
        role: scope.role,
        userId: scope.userId,
        employeeId: scope.employeeId,
        departmentId: scope.departmentId,
      };
      out.historical_search_runs = await this.selfTrackingService.listHistoricalSearchRuns(
        ctx,
        actorEmail,
        8,
      );
    }

    return out;
  }

  /** Team mailboxes in a department — used to scope conversations when thread rows lack `department_id`. */
  private async getEmployeeIdsInDepartment(companyId: string, departmentId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('department_id', departmentId)
      .or('mailbox_type.is.null,mailbox_type.eq.TEAM');
    if (error) {
      this.logger.warn(`getEmployeeIdsInDepartment: ${error.message}`);
      return [];
    }
    const ids = (data ?? []) as { id: string }[];
    return [...new Set(ids.map((r) => r.id))];
  }

  private async getEmployeeIdByEmail(companyId: string, email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const { data, error } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('email', normalized)
      .limit(1);
    if (error) {
      this.logger.warn(`getEmployeeIdByEmail: ${error.message}`);
      return null;
    }
    const row = (data ?? [])[0] as { id?: string } | undefined;
    return row?.id ?? null;
  }

  private async getEmployeeFilterOptions(
    companyId: string,
    departmentId?: string,
    departmentIds?: string[],
    /** CEO scope: always include these mailbox ids so the client does not drop out-of-department picks. */
    alsoIncludeEmployeeIds?: string[],
  ): Promise<
    { id: string; name: string; department_name: string | null; is_manager: boolean }[]
  > {
    let q = this.supabase
      .from('employees')
      .select('id, name, email, department_id')
      .eq('company_id', companyId)
      .or('mailbox_type.is.null,mailbox_type.eq.TEAM')
      .order('name', { ascending: true });
    if (departmentIds && departmentIds.length > 0) {
      q = q.in('department_id', departmentIds);
    } else if (departmentId) {
      q = q.eq('department_id', departmentId);
    }
    const [{ data, error }, deptsRes, headsRes] = await Promise.all([
      q,
      this.supabase.from('departments').select('id, name').eq('company_id', companyId),
      this.supabase
        .from('users')
        .select('email, department_id, linked_employee_id')
        .eq('company_id', companyId)
        .eq('role', 'HEAD'),
    ]);
    if (error) {
      this.logger.warn(`getEmployeeFilterOptions: ${error.message}`);
      return [];
    }
    const deptNameById = new Map(
      (deptsRes.data ?? []).map((r) => [r.id as string, (r.name as string) ?? '']),
    );
    const managerDeptEmail = new Set<string>();
    const managerByLinkedId = new Set<string>();
    for (const row of headsRes.data ?? []) {
      const did = row.department_id as string | null;
      const em = (row.email as string | undefined)?.trim().toLowerCase();
      if (did && em) managerDeptEmail.add(`${did}:${em}`);
      const link = row.linked_employee_id as string | null | undefined;
      if (link) managerByLinkedId.add(link);
    }
    const { data: mgrMems, error: mgrMemErr } = await this.supabase
      .from('manager_department_memberships')
      .select('department_id, user_id')
      .eq('company_id', companyId);
    if (!mgrMemErr && mgrMems?.length) {
      const uids = [...new Set((mgrMems as { user_id: string }[]).map((r) => r.user_id))];
      const { data: mgrUsers } = await this.supabase.from('users').select('id, email').in('id', uids);
      const emailByUser = new Map(
        (mgrUsers ?? []).map((u: { id: string; email: string }) => [
          u.id,
          u.email.trim().toLowerCase(),
        ]),
      );
      for (const m of mgrMems as { department_id: string; user_id: string }[]) {
        const em = emailByUser.get(m.user_id);
        if (em && m.department_id) managerDeptEmail.add(`${m.department_id}:${em}`);
      }
    }
    type EmpRow = { id: string; name: string; email: string; department_id: string };
    const mapRow = (e: EmpRow) => {
      const em = (e.email ?? '').trim().toLowerCase();
      const dn = e.department_id ? (deptNameById.get(e.department_id) ?? null) : null;
      const is_manager = Boolean(
        managerByLinkedId.has(e.id) ||
          (e.department_id && em && managerDeptEmail.has(`${e.department_id}:${em}`)),
      );
      return {
        id: e.id,
        name: e.name,
        department_name: dn,
        is_manager,
      };
    };
    const base = ((data ?? []) as EmpRow[]).map(mapRow);
    const byId = new Map(base.map((r) => [r.id, r]));
    const extraIds = [...new Set((alsoIncludeEmployeeIds ?? []).filter(Boolean))].filter((id) => !byId.has(id));
    if (extraIds.length === 0) return base;
    const { data: extraRows, error: extraErr } = await this.supabase
      .from('employees')
      .select('id, name, email, department_id')
      .eq('company_id', companyId)
      .in('id', extraIds)
      .or('mailbox_type.is.null,mailbox_type.eq.TEAM');
    if (extraErr) {
      this.logger.warn(`getEmployeeFilterOptions extra: ${extraErr.message}`);
      return base;
    }
    for (const e of (extraRows ?? []) as EmpRow[]) {
      byId.set(e.id, mapRow(e));
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async getOnboardingSnapshot(companyId: string): Promise<{
    show: boolean;
    employee_count: number;
    mailboxes_connected: number;
    state: 'NO_EMPLOYEES' | 'GMAIL_PENDING' | 'WAITING_FOR_SYNC' | 'READY';
    employee_added: boolean;
    waiting_for_sync: boolean;
  }> {
    const { data: emps } = await this.supabase
      .from('employees')
      .select('id, gmail_status, last_synced_at')
      .eq('company_id', companyId);
    const employee_count = emps?.length ?? 0;
    const rows = (emps ?? []) as Array<{
      id: string;
      gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
      last_synced_at?: string | null;
    }>;
    const mailboxes_connected = rows.filter((e) => (e.gmail_status ?? 'EXPIRED') === 'CONNECTED').length;
    const waiting_for_sync =
      employee_count > 0 &&
      mailboxes_connected > 0 &&
      rows.some((e) => (e.gmail_status ?? 'EXPIRED') === 'CONNECTED' && !e.last_synced_at);
    let state: 'NO_EMPLOYEES' | 'GMAIL_PENDING' | 'WAITING_FOR_SYNC' | 'READY' = 'READY';
    if (employee_count === 0) state = 'NO_EMPLOYEES';
    else if (mailboxes_connected === 0) state = 'GMAIL_PENDING';
    else if (waiting_for_sync) state = 'WAITING_FOR_SYNC';
    return {
      show: state !== 'READY',
      employee_count,
      mailboxes_connected,
      state,
      employee_added: employee_count > 0,
      waiting_for_sync,
    };
  }

  private async getDefaultSlaHours(): Promise<number> {
    const { data } = await this.supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'default_sla_hours')
      .maybeSingle();
    const n = Number((data as { value?: string } | null)?.value ?? '24');
    return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 24;
  }
}
