export type FollowUpStatus = 'DONE' | 'PENDING' | 'MISSED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH';
export type EmployeeRole = 'CEO' | 'HEAD' | 'EMPLOYEE' | 'PLATFORM_ADMIN';

export interface Employee {
  id: string;
  name: string;
  email: string;
  slaHoursDefault?: number;
  active: boolean;
  companyId?: string;
  departmentId?: string;
  role?: EmployeeRole;
  isActive?: boolean;
  aiEnabled?: boolean;
  trackingStartAt?: string | null;
  trackingPaused?: boolean;
  /** Present on GET /employees when including OAuth status */
  oauthConnected?: boolean;
  /** When false, skip AI for this employee (rules still run). Default true. */
  autoAiEnabled?: boolean;
  /** ISO timestamp — only ingest/analyze mail at or after this time (from mail_sync_state.start_date). */
  startTrackingAt?: string | null;
  /** `SELF` = CEO/manager self-tracking inbox; `TEAM` / null = org directory mailbox */
  mailboxType?: 'SELF' | 'TEAM' | null;
}

export interface EmailMessage {
  providerMessageId: string;
  providerThreadId: string;
  employeeId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  fromEmail: string;
  /** Human display name parsed from `From` header when available. */
  fromName?: string | null;
  /** Reply target parsed from `Reply-To` header; falls back to fromEmail when absent. */
  replyToEmail?: string | null;
  toEmails: string[];
  /** Parsed from `Cc` header (may be empty for older rows). */
  ccEmails: string[];
  subject: string;
  bodyText: string;
  sentAt: Date;
  /** Gmail label IDs — used for noise filtering (CATEGORY_PROMOTIONS etc.) */
  labelIds?: string[];
  /** Set after Gemini inbox relevance — persisted on `email_messages.relevance_reason`. */
  relevanceReason?: string | null;
}

export interface ConversationSnapshot {
  conversationId: string;
  providerThreadId: string;
  clientName: string;
  clientEmail: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  lastClientMsgAt: Date | null;
  lastEmployeeReplyAt: Date | null;
  followUpRequired: boolean;
  followUpStatus: FollowUpStatus;
  delayHours: number;
  priority: Priority;
  summary: string;
  confidence: number;
}

export interface AiOutput {
  priority: Priority;
  summary: string;
  confidence: number;
  contact_name?: string;
  is_automated?: boolean;
}

export interface MailSyncState {
  employeeId: string;
  startDate: Date;
  lastProcessedAt: Date | null;
  lastHistoryId: string | null;
}
