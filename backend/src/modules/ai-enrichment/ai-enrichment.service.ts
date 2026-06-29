import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { AiOutput, Priority } from '../common/types';
import { GeminiUsageService } from '../usage/gemini-usage.service';

interface EmailRow {
  direction: string;
  from_email: string;
  subject: string;
  body_text: string;
  sent_at: string;
}

const SYSTEM_PROMPT = `You are an email conversation analyzer.

Analyze the provided email thread (subject, sender, body) and return ONLY valid JSON:

{
"priority":"HIGH|MEDIUM|LOW",
"summary":"Clear actionable summary of the thread and required next step",
"contact_name":"External person's real name (or company name if automated)",
"confidence":0.0,
"is_automated":false,
"conversation_closed":false
}

Rules:

Priority:

* HIGH = urgent requests, deadlines, escalations, disputes, legal/compliance, repeated follow-ups.
* MEDIUM = real person expects a business reply/action.
* LOW = FYI, acknowledgments, newsletters, marketing, notifications, auto-generated emails, cold outreach.
* If conversation_closed=true, priority MUST be LOW.

Summary:

* Read the actual content, not just the subject.
* Explain what the thread is about, including important details (people, dates, amounts, projects, actions).
* Mention what response/action is needed.
* For automated/promotional emails, clearly identify them as such.

Contact Name:

* Extract the sender's real name from From header, signature, or message body.
* If automated, return the company/service name.
* Never return an email address when a name exists.

Conversation Closed:
Return true if the latest message indicates no further action is needed, including:

* resolved/closed/completed
* thanks, received, noted, sounds good, looks good, works for me, appreciated, etc.
* employee sent the last message and did not ask a question or request action

Return false if anyone is waiting for a reply, answer, decision, confirmation, deliverable, or action.

Confidence:

* 0.0–1.0 based on certainty.

Return ONLY the JSON object.
`;

@Injectable()
export class AiEnrichmentService {
  private readonly logger = new Logger(AiEnrichmentService.name);
  private readonly model;
  private readonly modelName: string;
  private monthlyQuotaExhausted = false;

  /** Cleared at the start of each ingestion / historical cycle so enrichment can retry after billing is fixed. */
  resetMonthlyQuotaGate(): void {
    this.monthlyQuotaExhausted = false;
  }

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly geminiUsageService: GeminiUsageService,
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set — AI enrichment will use fallback values');
    }
    const genAI = new GoogleGenerativeAI(apiKey ?? '');
    this.modelName = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
    this.model = genAI.getGenerativeModel({ model: this.modelName });
    this.logger.log(`AI enrichment model: ${this.modelName}`);
  }

  /** True when the API key is configured and AI can actually run. */
  get isAvailable(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  /** Run Gemini on raw thread text (e.g. tests or tooling). */
  async enrichThreadText(threadText: string): Promise<AiOutput | null> {
    return this.callGemini(threadText, null);
  }

  async enrichConversation(conversationId: string, employeeId: string, threadId: string): Promise<AiOutput | null> {
    const emails = await this.fetchRecentEmails(employeeId, threadId, 5);

    if (emails.length === 0) {
      return this.fallback();
    }

    const threadText = this.formatThread(emails);
    const companyId = await this.resolveCompanyId(employeeId);
    const result = await this.callGemini(threadText, companyId, employeeId);
    if (result === null) {
      this.logger.warn(
        `AI enrichment skipped for ${conversationId} — Gemini API limit reached (conversation row unchanged).`,
      );
      return null;
    }

    await this.updateConversation(conversationId, result);

    return result;
  }

  private async fetchRecentEmails(employeeId: string, threadId: string, limit: number): Promise<EmailRow[]> {
    const { data, error } = await this.supabase
      .from('email_messages')
      .select('direction, from_email, subject, body_text, sent_at')
      .eq('employee_id', employeeId)
      .eq('provider_thread_id', threadId)
      .order('sent_at', { ascending: true })
      .limit(limit);

    if (error) {
      this.logger.error(`Failed to fetch emails for thread ${threadId}`, error.message);
      return [];
    }

    return (data ?? []) as EmailRow[];
  }

  private formatThread(emails: EmailRow[]): string {
    return emails
      .map((email) => {
        const role = email.direction === 'INBOUND' ? 'Client' : 'Employee';
        const body = (email.body_text ?? '').slice(0, 1500);
        return `${role} (${email.from_email}):\nSubject: ${email.subject}\n${body}`;
      })
      .join('\n\n---\n\n');
  }

  private async resolveCompanyId(employeeId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('employees')
      .select('company_id')
      .eq('id', employeeId)
      .maybeSingle();
    return (data as { company_id?: string } | null)?.company_id ?? null;
  }

  private async callGemini(
    threadText: string,
    companyId: string | null,
    employeeId?: string,
    retries = 2,
  ): Promise<AiOutput | null> {
    if (!process.env.GEMINI_API_KEY) {
      return this.fallback();
    }

    if (this.monthlyQuotaExhausted) {
      return null;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const prompt = `${SYSTEM_PROMPT}\n\n--- EMAIL THREAD ---\n\n${threadText}`;
        const result = await this.model.generateContent(prompt);
        if (companyId) {
          void this.geminiUsageService.recordFromResponse(result.response, {
            companyId,
            employeeId: employeeId ?? null,
            operation: 'enrichment',
            model: this.modelName,
          });
        }
        const response = result.response;
        const text = response.text();
        return this.parseResponse(text);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        const is429 = /429|quota|rate.limit/i.test(msg);
        const isMonthly = /monthly|exceeded its|spending\s+cap|spend\s+cap/i.test(msg);

        if (is429 && isMonthly) {
          this.monthlyQuotaExhausted = true;
          this.logger.error(
            `Gemini API limit reached — AI enrichment paused (no DB updates until the next cycle). ${msg.slice(0, 200)}`,
          );
          return null;
        }

        if (is429 && attempt < retries) {
          const secMatch = msg.match(/retry in (\d+(\.\d+)?)\s*s/i);
          const msMatch = !secMatch ? msg.match(/retry in (\d+(\.\d+)?)\s*ms/i) : null;
          let waitSec = secMatch ? Math.ceil(Number(secMatch[1])) : msMatch ? Math.ceil(Number(msMatch[1]) / 1000) : 60;
          waitSec = Math.max(1, Math.min(waitSec, 120));
          this.logger.warn(`Rate limited — waiting ${waitSec}s before retry (attempt ${attempt + 1}/${retries})`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }

        this.logger.error(`Gemini API call failed (attempt ${attempt + 1}): ${msg.slice(0, 200)}`);
        return this.fallback();
      }
    }
    return this.fallback();
  }

  private parseResponse(text: string): AiOutput {
    try {
      const cleaned = text
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

      const parsed = JSON.parse(cleaned);

      const validPriorities: Priority[] = ['HIGH', 'MEDIUM', 'LOW'];
      const priority: Priority = validPriorities.includes(parsed.priority?.toUpperCase())
        ? parsed.priority.toUpperCase()
        : 'MEDIUM';

      const summary = typeof parsed.summary === 'string' && parsed.summary.length > 0
        ? parsed.summary.slice(0, 500)
        : '';

      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;

      const contact_name = typeof parsed.contact_name === 'string' && parsed.contact_name.length > 0
        ? parsed.contact_name.slice(0, 200)
        : undefined;

      const is_automated = typeof parsed.is_automated === 'boolean' ? parsed.is_automated : undefined;

      const conversation_closed = typeof parsed.conversation_closed === 'boolean' ? parsed.conversation_closed : undefined;

      return { priority, summary, confidence, contact_name, is_automated, conversation_closed };
    } catch {
      this.logger.warn('Failed to parse Gemini response, using fallback');
      return this.fallback();
    }
  }

  private async updateConversation(conversationId: string, output: AiOutput): Promise<void> {
    const updatePayload: Record<string, unknown> = {
      priority: output.is_automated ? 'LOW' : output.priority,
      summary: output.summary,
      confidence: output.confidence,
      updated_at: new Date().toISOString(),
    };

    if (output.contact_name) {
      updatePayload.client_name = output.contact_name;
    }

    if (output.conversation_closed === true) {
      updatePayload.follow_up_required = false;
      updatePayload.follow_up_status = 'DONE';
      updatePayload.lifecycle_status = 'RESOLVED';
      updatePayload.priority = 'LOW';
      updatePayload.short_reason = 'AI detected conversation closed by client — no reply needed.';
      updatePayload.reason = 'AI detected conversation closed by client — no reply needed.';
    }

    const { error } = await this.supabase
      .from('conversations')
      .update(updatePayload)
      .eq('conversation_id', conversationId);

    if (error) {
      this.logger.error(`Failed to update AI fields for ${conversationId}`, error.message);
    } else {
      this.logger.log(
        `AI wrote summary for ${conversationId}: "${output.summary?.slice(0, 80)}..." | priority=${output.priority} | contact=${output.contact_name ?? 'n/a'} | automated=${output.is_automated ?? false}`,
      );
    }
  }

  private fallback(): AiOutput {
    return { priority: 'MEDIUM', summary: '', confidence: 0.5 };
  }
}
