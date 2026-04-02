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
Analyze the email thread below and return ONLY a valid JSON object with no additional text:

{
  "priority": "HIGH | MEDIUM | LOW",
  "summary": "1-2 sentence summary of the conversation and what action is needed",
  "confidence": 0.0 to 1.0
}

Priority rules:
- HIGH: urgent requests, angry tone, escalations, payment/billing issues, repeated follow-ups, deadlines
- MEDIUM: normal pending follow-up, standard business questions awaiting response
- LOW: informational messages, FYI, thank-you notes, no action required

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
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  shouldEnrich(conversation: {
    follow_up_required: boolean;
    priority: string | null;
    summary: string | null;
  }): boolean {
    if (!conversation.follow_up_required) {
      return false;
    }

    const hasPriority = conversation.priority && conversation.priority !== 'MEDIUM';
    const hasSummary = conversation.summary && conversation.summary.length > 0;

    return !hasPriority || !hasSummary;
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
        const body = (email.body_text ?? '').slice(0, 400);
        return `${role} (${email.from_email}):\nSubject: ${email.subject}\n${body}`;
      })
      .join('\n\n---\n\n');
  }

  private async callGemini(threadText: string): Promise<AiOutput> {
    if (!process.env.GEMINI_API_KEY) {
      return this.fallback();
    }

    try {
      const prompt = `${SYSTEM_PROMPT}\n\n--- EMAIL THREAD ---\n\n${threadText}`;
      const result = await this.model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      return this.parseResponse(text);
    } catch (err) {
      this.logger.error('Gemini API call failed', (err as Error).message);
      return this.fallback();
    }
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

      return { priority, summary, confidence };
    } catch {
      this.logger.warn('Failed to parse Gemini response, using fallback');
      return this.fallback();
    }
  }

  private async updateConversation(conversationId: string, output: AiOutput): Promise<void> {
    const { error } = await this.supabase
      .from('conversations')
      .update({
        priority: output.priority,
        summary: output.summary,
        confidence: output.confidence,
        updated_at: new Date().toISOString(),
      })
      .eq('conversation_id', conversationId);

    if (error) {
      this.logger.error(`Failed to update AI fields for ${conversationId}`, error.message);
    }
  }

  private fallback(): AiOutput {
    return { priority: 'MEDIUM', summary: '', confidence: 0.5 };
  }
}
