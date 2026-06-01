import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

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
      this.logger.log('SMTP configured — alert emails enabled');
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

  private async canSendAlert(companyId: string): Promise<boolean> {
    const key = `email_alert_last_sent_at_${companyId}`;
    const { data } = await this.supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
    const last = (data as { value?: string } | null)?.value;
    if (!last) return true;
    const age = Date.now() - new Date(last).getTime();
    return age >= ALERT_COOLDOWN_MS;
  }

  private async markAlertSent(companyId: string): Promise<void> {
    const key = `email_alert_last_sent_at_${companyId}`;
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

    if (!(await this.canSendAlert(companyId))) {
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
      await this.markAlertSent(companyId);
      if (conversationId) {
        await this.supabase
          .from('conversations')
          .update({ last_alert_sent_at: new Date().toISOString() })
          .eq('company_id', companyId)
          .eq('conversation_id', conversationId);
      }
    }
  }

}
