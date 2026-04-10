import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { AiOutput, Priority } from '../common/types';

interface EmailRow {
  direction: string;
  from_email: string;
  subject: string;
  body_text: string;
  sent_at: string;
}

const SYSTEM_PROMPT = `You are an email conversation analyzer for a business follow-up monitoring system.
Your job is to READ the actual email content — subject, body, and sender — and produce a meaningful analysis.

Analyze the email thread below and return ONLY a valid JSON object with no additional text:

{
  "priority": "HIGH" | "MEDIUM" | "LOW",
  "summary": "A clear, actionable summary of what this email thread is about and what response is needed. Example: 'Client John asking about Q2 project timeline — needs delivery date confirmation' or 'Invoice #4521 from Acme Corp for $2,400 — payment due April 15'",
  "contact_name": "The real human name of the external person (client/vendor/partner), extracted from email signature, greeting, or From header. Use the actual name, not the email address.",
  "confidence": 0.0 to 1.0,
  "is_automated": true | false
}

Priority rules:
- HIGH: urgent business requests, escalations, angry tone, payment disputes, legal/compliance, repeated follow-ups, deadlines
- MEDIUM: a real person expects a reply about work, projects, orders, support, meetings, partnerships
- LOW: informational/FYI, thank-you notes, auto-replies, newsletters, marketing, automated notifications, system-generated emails, cold sales pitches, promotional content — even if subject says "urgent"

Summary rules:
- DO NOT just repeat the subject line. READ the email body and explain what the conversation is actually about.
- Include specific details: names, amounts, dates, project names, action items.
- If the email needs a reply, say what kind of reply is needed.
- If it's automated/marketing, say so clearly: "Automated billing notification from Zoom" or "Marketing newsletter from HackerNoon".

Contact name rules:
- Extract the real person's name from the email content (signature block, greeting like "Hi, I'm John", From header name).
- If it's an automated sender (noreply@, billing@, etc.), return the company name instead.
- Never return just an email address if a real name is available.

Return ONLY the JSON object. No markdown, no explanation.`;

@Injectable()
export class AiEnrichmentService {
  private readonly logger = new Logger(AiEnrichmentService.name);
  private readonly model;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set — AI enrichment will use fallback values');
    }
    const genAI = new GoogleGenerativeAI(apiKey ?? '');
    const modelName = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
    this.model = genAI.getGenerativeModel({ model: modelName });
    this.logger.log(`AI enrichment model: ${modelName}`);
  }

  /** True when the API key is configured and AI can actually run. */
  get isAvailable(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  /** Run Gemini on raw thread text (e.g. tests or tooling). */
  async enrichThreadText(threadText: string): Promise<AiOutput> {
    return this.callGemini(threadText);
  }

  async enrichConversation(conversationId: string, employeeId: string, threadId: string): Promise<AiOutput> {
    const emails = await this.fetchRecentEmails(employeeId, threadId, 5);

    if (emails.length === 0) {
      return this.fallback();
    }

    const threadText = this.formatThread(emails);
    const result = await this.callGemini(threadText);

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

  private async callGemini(threadText: string, retries = 2): Promise<AiOutput> {
    if (!process.env.GEMINI_API_KEY) {
      return this.fallback();
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const prompt = `${SYSTEM_PROMPT}\n\n--- EMAIL THREAD ---\n\n${threadText}`;
        const result = await this.model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        return this.parseResponse(text);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        const is429 = /429|quota|rate.limit/i.test(msg);

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

      return { priority, summary, confidence, contact_name, is_automated };
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
