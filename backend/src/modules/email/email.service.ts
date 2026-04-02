import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const REPORT_COOLDOWN_MS = 1 * 60 * 60 * 1000;

export interface AlertEmailLine {
  employee: string;
  hours: number;
  status: string;
  client_email: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter | null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {
    const host = process.env.SMTP_HOST?.trim();
    const port = Number(process.env.SMTP_PORT ?? '587');
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.trim();
    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log('SMTP configured — alert/report emails enabled');
    } else {
      this.transporter = null;
      this.logger.warn('SMTP not configured — email alerts disabled (set SMTP_HOST, SMTP_USER, SMTP_PASS)');
    }
  }

  private dashboardLink(): string {
    const base = process.env.FRONTEND_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';
    return `${base}/dashboard`;
  }

  async getCeoEmail(companyId: string): Promise<string | null> {
    const { data: ceo } = await this.supabase
      .from('users')
      .select('email')
      .eq('company_id', companyId)
      .eq('role', 'CEO')
      .limit(1)
      .maybeSingle();
    if ((ceo as { email?: string } | null)?.email) {
      return (ceo as { email: string }).email;
    }
    const { data: anyUser } = await this.supabase
      .from('users')
      .select('email')
      .eq('company_id', companyId)
      .limit(1)
      .maybeSingle();
    return (anyUser as { email?: string } | null)?.email ?? null;
  }

  private async canSend(companyId: string, keySuffix: 'alert' | 'report'): Promise<boolean> {
    const key = `email_${keySuffix}_last_sent_at_${companyId}`;
    const { data } = await this.supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
    const last = (data as { value?: string } | null)?.value;
    if (!last) return true;
    const age = Date.now() - new Date(last).getTime();
    const need = keySuffix === 'alert' ? ALERT_COOLDOWN_MS : REPORT_COOLDOWN_MS;
    return age >= need;
  }

  private async markSent(companyId: string, keySuffix: 'alert' | 'report'): Promise<void> {
    const key = `email_${keySuffix}_last_sent_at_${companyId}`;
    await this.supabase.from('system_settings').upsert(
      { key, value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  }

  async sendAlertEmail(to: string, recipientName: string, lines: AlertEmailLine[]): Promise<boolean> {
    if (!this.transporter || lines.length === 0) return false;
    const n = lines.length;
    const bodyLines = lines
      .map(
        (l) =>
          `• ${l.employee} — no reply for ${Math.round(l.hours)}h (${l.status}) — ${l.client_email || 'unknown client'}`,
      )
      .join('\n');
    const text = `Hi ${recipientName || 'there'},

We detected issues:

${bodyLines}

View dashboard: ${this.dashboardLink()}
`;
    const html = `<p>Hi ${recipientName || 'there'},</p><p>We detected issues:</p><ul>${lines
      .map(
        (l) =>
          `<li><strong>${this.escapeHtml(l.employee)}</strong> — no reply for ${Math.round(l.hours)}h (${this.escapeHtml(l.status)}) — ${this.escapeHtml(l.client_email || 'unknown client')}</li>`,
      )
      .join('')}</ul><p><a href="${this.dashboardLink()}">Open dashboard</a></p>`;

    try {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to,
        subject: `🚨 Follow-up Alert (${n} issue${n === 1 ? '' : 's'})`,
        text,
        html,
      });
      return true;
    } catch (err) {
      this.logger.error(`sendAlertEmail failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * CEO + department heads (HEAD) — for hourly AI report emails.
   */
  async getReportRecipientEmails(companyId: string): Promise<{ emails: string[]; greetingName: string }> {
    const { data, error } = await this.supabase
      .from('users')
      .select('email, full_name, role')
      .eq('company_id', companyId)
      .in('role', ['CEO', 'HEAD']);

    if (error || !data?.length) {
      const fallback = await this.getCeoEmail(companyId);
      return {
        emails: fallback ? [fallback] : [],
        greetingName: 'there',
      };
    }

    const rows = data as Array<{ email: string; full_name: string | null; role: string }>;
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const r of rows) {
      const e = r.email?.trim().toLowerCase();
      if (e && !seen.has(e)) {
        seen.add(e);
        emails.push(r.email.trim());
      }
    }

    const ceo = rows.find((r) => r.role === 'CEO');
    const greetingName =
      ceo?.full_name?.trim() || rows.find((r) => r.full_name?.trim())?.full_name?.trim() || 'there';

    return { emails, greetingName };
  }

  async sendReportEmail(
    to: string | string[],
    recipientName: string,
    metrics: {
      generated_at: string;
      key_issues: string[];
      employee_insights: string[];
      patterns: string[];
      recommendation: string;
      totals: { total: number; pending: number; missed: number; avg_delay: number };
    },
  ): Promise<boolean> {
    if (!this.transporter) return false;
    const toList = Array.isArray(to) ? to : [to];
    if (toList.length === 0) return false;
    const ki = metrics.key_issues ?? [];
    const ei = metrics.employee_insights ?? [];
    const pt = metrics.patterns ?? [];
    const fmtList = (title: string, items: string[]) =>
      items.length
        ? `${title}\n${items.map((x) => `  • ${x}`).join('\n')}\n`
        : `${title}\n  (none)\n`;
    const text = `Hi ${recipientName || 'there'},

AI Auto Mail — follow-up report
Generated: ${metrics.generated_at ? new Date(metrics.generated_at).toISOString() : new Date().toISOString()}

Summary
  • Total conversations: ${metrics.totals.total}
  • Pending: ${metrics.totals.pending}
  • Missed: ${metrics.totals.missed}
  • Average delay: ${metrics.totals.avg_delay} hours

${fmtList('Key issues', ki)}
${fmtList('Employee insights', ei)}
${fmtList('Patterns', pt)}
${metrics.recommendation ? `Recommendation\n  ${metrics.recommendation}\n` : ''}
Open your dashboard: ${this.dashboardLink()}
`;
    const sectionHtml = (title: string, items: string[]) => {
      const lis = items.length
        ? items.map((i) => `<li style="margin:0 0 10px 0;line-height:1.5;">${this.escapeHtml(i)}</li>`).join('')
        : '<li style="color:#6b7280;">No items in this section.</li>';
      return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
  <tr><td style="font-family:Georgia,serif;font-size:18px;font-weight:600;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:8px;">${this.escapeHtml(title)}</td></tr>
  <tr><td style="padding-top:12px;"><ul style="margin:0;padding-left:20px;font-family:system-ui,sans-serif;font-size:15px;color:#374151;">${lis}</ul></td></tr>
</table>`;
    };
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.06);">
      <tr><td style="background:#111827;color:#ffffff;padding:24px 28px;font-family:system-ui,sans-serif;">
        <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">AI Auto Mail</div>
        <div style="font-size:22px;font-weight:700;margin-top:8px;">Follow-up intelligence report</div>
        <div style="font-size:13px;margin-top:8px;opacity:0.9;">${metrics.generated_at ? this.escapeHtml(new Date(metrics.generated_at).toLocaleString()) : ''}</div>
      </td></tr>
      <tr><td style="padding:28px;font-family:system-ui,sans-serif;font-size:15px;color:#374151;">
        <p style="margin:0 0 20px 0;line-height:1.6;">Hi ${this.escapeHtml(recipientName || 'there')},</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Summary</div>
            <table role="presentation" style="margin-top:12px;font-size:14px;">
              <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Total</td><td style="font-weight:600;">${metrics.totals.total}</td></tr>
              <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Pending</td><td style="font-weight:600;">${metrics.totals.pending}</td></tr>
              <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Missed</td><td style="font-weight:600;">${metrics.totals.missed}</td></tr>
              <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Avg delay</td><td style="font-weight:600;">${metrics.totals.avg_delay}h</td></tr>
            </table>
          </td></tr>
        </table>
        ${sectionHtml('Key issues', ki)}
        ${sectionHtml('Employee insights', ei)}
        ${sectionHtml('Patterns', pt)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;background:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
          <tr><td style="padding:18px 20px;">
            <div style="font-size:12px;font-weight:600;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.06em;">Recommendation</div>
            <p style="margin:10px 0 0 0;font-size:15px;line-height:1.6;color:#1e3a8a;">${metrics.recommendation ? this.escapeHtml(metrics.recommendation) : 'No recommendation for this period.'}</p>
          </td></tr>
        </table>
        <p style="margin:24px 0 0 0;text-align:center;">
          <a href="${this.dashboardLink()}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;font-size:14px;">Open dashboard</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

    try {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to: toList,
        subject: '📊 AI Follow-up Report (hourly)',
        text,
        html,
      });
      return true;
    } catch (err) {
      this.logger.error(`sendReportEmail failed: ${(err as Error).message}`);
      return false;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** MISSED / SLA alerts — max once per 2h per company. */
  async maybeSendMissedAlert(
    companyId: string,
    line: AlertEmailLine,
    conversationId?: string,
  ): Promise<void> {
    if (conversationId) {
      const { data: c } = await this.supabase
        .from('conversations')
        .select('last_alert_sent_at')
        .eq('company_id', companyId)
        .eq('conversation_id', conversationId)
        .maybeSingle();
      const last = (c as { last_alert_sent_at?: string | null } | null)?.last_alert_sent_at;
      if (last && Date.now() - new Date(last).getTime() < ALERT_COOLDOWN_MS) {
        this.logger.debug(`Alert skipped for conversation ${conversationId} (conversation cooldown)`);
        return;
      }
    }

    if (!(await this.canSend(companyId, 'alert'))) {
      this.logger.debug(`Alert email skipped (cooldown) for company ${companyId}`);
      return;
    }
    const to = await this.getCeoEmail(companyId);
    if (!to) {
      this.logger.warn(`No CEO/user email for company ${companyId} — alert not sent`);
      return;
    }
    const { data: u } = await this.supabase
      .from('users')
      .select('full_name, email')
      .eq('company_id', companyId)
      .eq('role', 'CEO')
      .limit(1)
      .maybeSingle();
    const name = (u as { full_name?: string; email?: string } | null)?.full_name ?? 'there';
    const ok = await this.sendAlertEmail(to, name, [line]);
    if (ok) {
      await this.markSent(companyId, 'alert');
      if (conversationId) {
        await this.supabase
          .from('conversations')
          .update({ last_alert_sent_at: new Date().toISOString() })
          .eq('company_id', companyId)
          .eq('conversation_id', conversationId);
      }
    }
  }

  /** After AI report generation — max once per 1h per company. Sends to CEO + all HEAD (managers). */
  async maybeSendReportAfterGeneration(
    companyId: string,
    report: {
      generated_at: string;
      key_issues: string[];
      employee_insights: string[];
      patterns: string[];
      recommendation: string;
    },
    totals: { total: number; pending: number; missed: number; avg_delay: number },
  ): Promise<void> {
    if (!(await this.canSend(companyId, 'report'))) {
      this.logger.debug(`Report email skipped (cooldown) for company ${companyId}`);
      return;
    }
    const { emails, greetingName } = await this.getReportRecipientEmails(companyId);
    if (emails.length === 0) {
      this.logger.warn(`No CEO/HEAD emails for company ${companyId} — hourly report email not sent`);
      return;
    }
    const ok = await this.sendReportEmail(emails, greetingName, { ...report, totals });
    if (ok) {
      await this.markSent(companyId, 'report');
      this.logger.log(`Hourly AI report emailed to ${emails.length} recipient(s) for company ${companyId}`);
    }
  }
}
