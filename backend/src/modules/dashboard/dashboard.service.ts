import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { TelegramService } from '../alerts/telegram.service';
import { EmailService } from '../email/email.service';
import { SettingsService } from '../settings/settings.service';
import type { EmployeeRole } from '../common/types';

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
  open_gmail_link: string;
}

interface ConversationDbRow {
  conversation_id: string;
  employee_id: string;
  provider_thread_id: string;
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
}

export interface ConversationFilters {
  companyId: string;
  status?: string;
  employeeId?: string;
  departmentId?: string;
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

export interface SimplifiedDashboardResponse {
  needs_attention: ConversationListItem[];
  ai_insights: { lines: string[]; last_updated_at: string | null };
  conversations: ConversationListItem[];
  onboarding: {
    show: boolean;
    employee_count: number;
    mailboxes_connected: number;
    state: 'NO_EMPLOYEES' | 'GMAIL_PENDING' | 'WAITING_FOR_SYNC' | 'READY';
    employee_added: boolean;
    waiting_for_sync: boolean;
  };
  employee_filter_options: { id: string; name: string }[];
  my_followups?: { missed: number; pending: number; done: number };
  /** Populated for CEO only — department vs manager vs thread pressure. */
  ceo_department_rollups?: CeoDepartmentRollup[];
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
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey ?? '');
    this.aiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  async getGlobalMetrics(companyId: string, departmentId?: string): Promise<GlobalMetrics> {
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
    const rows = (data ?? []) as Array<{ follow_up_status: string; priority: string; delay_hours: number; lifecycle_status: string }>;
    const total = rows.length;
    const done = rows.filter((r) => r.follow_up_status === 'DONE').length;
    const pending = rows.filter((r) => r.follow_up_status === 'PENDING').length;
    const missed = rows.filter((r) => r.follow_up_status === 'MISSED').length;
    const highPriorityMissed = rows.filter((r) => r.follow_up_status === 'MISSED' && r.priority === 'HIGH').length;
    const avgDelay = rows.length ? Number((rows.reduce((s, r) => s + Number(r.delay_hours ?? 0), 0) / rows.length).toFixed(2)) : 0;
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
      .eq('is_active', true);
    if (departmentId) {
      empQuery = empQuery.eq('department_id', departmentId);
    }
    const { data, error } = await empQuery;
    if (error) {
      this.logger.error('Failed to get employee performance', error.message);
      throw error;
    }
    const employees = (data ?? []) as Array<{ id: string; name: string; email: string }>;
    const result: EmployeePerformance[] = [];
    for (const e of employees) {
      const conversations = await this.getConversationsList({ companyId, employeeId: e.id });
      result.push({
        employee_id: e.id,
        employee_name: e.name,
        employee_email: e.email,
        total: conversations.length,
        done: conversations.filter((c) => c.follow_up_status === 'DONE').length,
        pending: conversations.filter((c) => c.follow_up_status === 'PENDING').length,
        missed: conversations.filter((c) => c.follow_up_status === 'MISSED').length,
        avg_delay_hours: conversations.length
          ? Number((conversations.reduce((s, c) => s + Number(c.delay_hours ?? 0), 0) / conversations.length).toFixed(2))
          : 0,
      });
    }
    return result;
  }

  async getConversationsList(filters: ConversationFilters): Promise<ConversationListItem[]> {
    let query = this.supabase
      .from('conversations')
      .select('conversation_id, employee_id, company_id, department_id, provider_thread_id, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored')
      .eq('company_id', filters.companyId)
      .eq('is_ignored', false)
      .order('updated_at', { ascending: false });

    if (filters.departmentId) query = query.eq('department_id', filters.departmentId);
    if (filters.status) query = query.eq('follow_up_status', filters.status);
    if (filters.employeeId) query = query.eq('employee_id', filters.employeeId);
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
      const tid = encodeURIComponent(r.provider_thread_id);
      const emp = employeeById.get(r.employee_id);
      return {
        conversation_id: r.conversation_id,
        employee_id: r.employee_id,
        employee_name: emp?.name ?? r.employee_id,
        provider_thread_id: r.provider_thread_id,
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
        open_gmail_link: `https://mail.google.com/mail/u/0/#inbox/${tid}`,
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
        dataBlock = [
          `Department metrics: ${JSON.stringify(metrics)}`,
          `Team mailboxes: ${JSON.stringify(
            employees.map((e) => ({
              name: e.employee_name,
              email: e.employee_email,
              total: e.total,
              missed: e.missed,
              pending: e.pending,
              avg_delay: e.avg_delay_hours,
            })),
          )}`,
          `Needs attention (${attention.length}): ${JSON.stringify(
            attention.slice(0, 12).map((c) => ({
              client: c.client_email,
              assigned_to: c.employee_name,
              status: c.follow_up_status,
              priority: c.priority,
              delay: c.delay_hours,
              reason: c.short_reason,
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

Keep bullets under 20 words. Use client/employee detail from the data when useful.

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
      .eq('company_id', companyId)
      .eq('report_scope', scope);

    if (scope === 'DEPARTMENT_HEAD') {
      if (!opts?.departmentId) return null;
      q = q.eq('department_id', opts.departmentId);
    } else {
      q = q.is('department_id', null);
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
      .select('content, created_at, report_scope, department_id')
      .eq('company_id', companyId)
      .eq('report_scope', scope);

    if (scope === 'DEPARTMENT_HEAD') {
      if (!opts?.departmentId) return [];
      q = q.eq('department_id', opts.departmentId);
    } else {
      q = q.is('department_id', null);
    }

    const { data, error } = await q.order('created_at', { ascending: false }).limit(safeLimit);

    if (error) {
      this.logger.error('Failed to load AI report archive', error.message);
      const { data: legacy } = await this.supabase
        .from('dashboard_reports')
        .select('content, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(safeLimit);
      const rows = (legacy ?? []) as Array<{ content: Partial<AiReport> | null; created_at: string }>;
      return rows.map((r) => ({
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

    const rows = (data ?? []) as Array<{ content: Partial<AiReport> | null; created_at: string }>;
    return rows.map((r) => ({
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

  /**
   * Aggregates conversations by department with HEAD manager from `users`.
   * Used on the CEO dashboard for org-wide graphs (no client emails).
   *
   * Effective department = conversation.department_id ?? employee.department_id (threads often only set on employee).
   * Emits one rollup per bucket that has threads (including unknown UUIDs and unassigned).
   */
  async getCeoDepartmentRollups(companyId: string): Promise<CeoDepartmentRollup[]> {
    const { data: convoRows, error: cErr } = await this.supabase
      .from('conversations')
      .select('department_id, employee_id, follow_up_status, priority')
      .eq('company_id', companyId)
      .eq('is_ignored', false);
    if (cErr) {
      this.logger.warn(`getCeoDepartmentRollups conversations: ${cErr.message}`);
      return [];
    }

    const raw = (convoRows ?? []) as Array<{
      department_id: string | null;
      employee_id: string;
      follow_up_status: string;
      priority: string;
    }>;

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
    const headByDept = new Map(
      (heads ?? []).map((h) => [h.department_id as string, h as { full_name: string | null; email: string }]),
    );

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

    /** Every department in the org directory — include zeros so CEO always sees department + manager columns. */
    for (const d of allDeptRows) {
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
    scope: { departmentId?: string; employeeId?: string; role: EmployeeRole },
    filters?: { status?: string; employeeId?: string; priority?: string },
  ): Promise<SimplifiedDashboardResponse> {
    const scopedEmployeeId = scope.role === 'EMPLOYEE' ? scope.employeeId : undefined;
    const filterEmployee =
      scope.role === 'EMPLOYEE' ? scopedEmployeeId : filters?.employeeId ?? scopedEmployeeId;

    const settings = await this.settingsService.getAll();
    const reportPromise =
      scope.role === 'CEO'
        ? this.getLastAiReport(companyId, { scope: 'EXECUTIVE' })
        : scope.role === 'HEAD' &&
            scope.departmentId &&
            settings.ai_enabled &&
            settings.ai_for_managers_enabled
          ? this.getLastAiReport(companyId, { scope: 'DEPARTMENT_HEAD', departmentId: scope.departmentId })
          : Promise.resolve(null);

    const rollupsPromise =
      scope.role === 'CEO' ? this.getCeoDepartmentRollups(companyId) : Promise.resolve(undefined);

    const [report, all, onboarding, employeeFilterOptions, ceo_department_rollups] = await Promise.all([
      reportPromise,
      this.getConversationsList({
        companyId,
        departmentId: scope.departmentId,
        employeeId: filterEmployee,
        status: filters?.status,
        priority: filters?.priority,
      }),
      this.getOnboardingSnapshot(companyId),
      scope.role === 'EMPLOYEE'
        ? Promise.resolve([] as { id: string; name: string }[])
        : this.getEmployeeFilterOptions(companyId),
      rollupsPromise,
    ]);

    const attentionCap = scope.role === 'HEAD' ? 50 : scope.role === 'CEO' ? 12 : 5;
    const needs_attention = all
      .filter(
        (c) =>
          c.follow_up_status === 'MISSED' ||
          (c.priority === 'HIGH' && c.follow_up_status !== 'DONE'),
      )
      .slice(0, attentionCap);

    const insightLines =
      scope.role === 'EMPLOYEE'
        ? []
        : [
            ...(report?.key_issues ?? []),
            ...(report?.employee_insights ?? []),
            ...(report?.patterns ?? []),
          ];

    const out: SimplifiedDashboardResponse = {
      needs_attention,
      ai_insights: {
        lines: insightLines,
        last_updated_at: scope.role === 'EMPLOYEE' ? null : (report?.generated_at ?? null),
      },
      conversations: all,
      onboarding,
      employee_filter_options: employeeFilterOptions,
    };

    if (scope.role === 'CEO') {
      out.ceo_department_rollups = ceo_department_rollups ?? [];
    }

    if (scope.role === 'EMPLOYEE' && scope.employeeId) {
      out.my_followups = {
        missed: all.filter((c) => c.follow_up_status === 'MISSED').length,
        pending: all.filter((c) => c.follow_up_status === 'PENDING').length,
        done: all.filter((c) => c.follow_up_status === 'DONE').length,
      };
    }

    return out;
  }

  private async getEmployeeFilterOptions(companyId: string): Promise<{ id: string; name: string }[]> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, name')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.warn(`getEmployeeFilterOptions: ${error.message}`);
      return [];
    }
    return (data ?? []) as { id: string; name: string }[];
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
