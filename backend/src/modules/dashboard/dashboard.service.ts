import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { TelegramService } from '../alerts/telegram.service';

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
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  summary: string;
  short_reason: string;
  last_client_msg_at: string | null;
  last_employee_reply_at: string | null;
  follow_up_required: boolean;
  confidence: number;
  lifecycle_status: string;
  manually_closed: boolean;
  is_ignored: boolean;
}

interface ConversationDbRow {
  conversation_id: string;
  employee_id: string;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  summary: string;
  short_reason: string;
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

export interface DashboardResponse {
  stats: {
    needs_attention: number;
    missed: number;
    pending: number;
    resolved: number;
    avg_delay: number;
  };
  needs_attention: ConversationListItem[];
  ai_insights: string[];
  conversations: ConversationListItem[];
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private readonly aiModel;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly telegramService: TelegramService,
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey ?? '');
    this.aiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  async getGlobalMetrics(companyId: string): Promise<GlobalMetrics> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('follow_up_status, priority, delay_hours, lifecycle_status', { count: 'exact' })
      .eq('company_id', companyId)
      .eq('is_ignored', false);
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

  async getEmployeePerformance(companyId: string): Promise<EmployeePerformance[]> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, name, email')
      .eq('company_id', companyId)
      .eq('is_active', true);
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
      .select('conversation_id, employee_id, company_id, department_id, client_email, follow_up_status, priority, delay_hours, summary, short_reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored')
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
      .select('id, name')
      .in('id', ids);
    const nameById = new Map((employees ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));
    return rows.map((r) => ({
      ...r,
      employee_name: nameById.get(r.employee_id) ?? r.employee_id,
    }));
  }

  async generateAiReport(companyId: string, force = false): Promise<AiReport> {
    const fallback: AiReport = {
      generated_at: new Date().toISOString(),
      key_issues: ['Unable to generate AI report — check GEMINI_API_KEY'],
      employee_insights: [],
      patterns: [],
      recommendation: '',
    };

    if (!process.env.GEMINI_API_KEY) return fallback;

    // Enforce 1-hour cooldown unless forced (e.g. manual trigger)
    if (!force) {
      const existing = await this.getLastAiReport(companyId);
      if (existing?.generated_at) {
        const ageMs = Date.now() - new Date(existing.generated_at).getTime();
        if (ageMs < 3600_000) {
          this.logger.debug(`Skipping AI report — last generated ${Math.round(ageMs / 60_000)}m ago (cooldown: 60m)`);
          return existing;
        }
      }
    }

    try {
      const metrics = await this.getGlobalMetrics(companyId);
      const employees = await this.getEmployeePerformance(companyId);
      const attention = await this.getConversationsList({ companyId, lifecycle: 'NEEDS_ATTENTION' });

      const dataBlock = [
        `Metrics: ${JSON.stringify(metrics)}`,
        `Employees: ${JSON.stringify(employees.map((e) => ({ name: e.employee_name, total: e.total, missed: e.missed, pending: e.pending, avg_delay: e.avg_delay_hours })))}`,
        `Needs attention (${attention.length}): ${JSON.stringify(attention.slice(0, 10).map((c) => ({ client: c.client_email, employee: c.employee_name, status: c.follow_up_status, priority: c.priority, delay: c.delay_hours, reason: c.short_reason })))}`,
      ].join('\n');

      const prompt = `You are a CEO dashboard AI analyst for a follow-up monitoring system.
Given this data, return ONLY a valid JSON object (no markdown, no explanation):

{
  "key_issues": ["up to 3 short bullet points about critical issues"],
  "employee_insights": ["up to 2 short bullet points about employee performance"],
  "patterns": ["up to 2 short bullet points about detected patterns"],
  "recommendation": "1 sentence actionable recommendation"
}

Keep each bullet under 15 words. Be specific with numbers.

--- DATA ---
${dataBlock}`;

      const result = await this.aiModel.generateContent(prompt);
      const text = result.response.text()
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

      const parsed = JSON.parse(text);

      const report: AiReport = {
        generated_at: new Date().toISOString(),
        key_issues: Array.isArray(parsed.key_issues) ? parsed.key_issues.slice(0, 4) : [],
        employee_insights: Array.isArray(parsed.employee_insights) ? parsed.employee_insights.slice(0, 3) : [],
        patterns: Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 3) : [],
        recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation.slice(0, 200) : '',
      };

      await this.supabase.from('dashboard_reports').insert({
        company_id: companyId,
        content: report,
        created_at: report.generated_at,
      });

      // Send AI report to Telegram (non-blocking)
      if (this.telegramService.isConfigured()) {
        this.telegramService.sendAiReport(report).catch((err) => {
          this.logger.warn(`Failed to send AI report to Telegram: ${(err as Error).message}`);
        });
      }

      return report;
    } catch (err) {
      this.logger.error('AI report generation failed', (err as Error).message);
      return fallback;
    }
  }

  async getLastAiReport(companyId: string): Promise<AiReport | null> {
    const { data } = await this.supabase
      .from('dashboard_reports')
      .select('content, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    try {
      return (data as { content: AiReport }).content;
    } catch {
      return null;
    }
  }

  async getDashboard(companyId: string, scope: { departmentId?: string; employeeId?: string }): Promise<DashboardResponse> {
    const [report, all] = await Promise.all([
      this.getLastAiReport(companyId),
      this.getConversationsList({ companyId, departmentId: scope.departmentId, employeeId: scope.employeeId }),
    ]);
    const needsAttention = all.filter((c) => c.lifecycle_status === 'NEEDS_ATTENTION').slice(0, 5);
    const insights = [
      ...(report?.key_issues ?? []),
      ...(report?.employee_insights ?? []),
      ...(report?.patterns ?? []),
    ];
    return {
      stats: {
        needs_attention: all.filter((c) => c.lifecycle_status === 'NEEDS_ATTENTION').length,
        missed: all.filter((c) => c.follow_up_status === 'MISSED').length,
        pending: all.filter((c) => c.follow_up_status === 'PENDING').length,
        resolved: all.filter((c) => c.lifecycle_status === 'RESOLVED').length,
        avg_delay: all.length
          ? Number((all.reduce((sum, c) => sum + Number(c.delay_hours ?? 0), 0) / all.length).toFixed(2))
          : 0,
      },
      needs_attention: needsAttention,
      ai_insights: insights,
      conversations: all,
    };
  }
}
