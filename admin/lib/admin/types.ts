export type PlatformStats = {
  companies_registered: number;
  total_users: number;
  total_employees: number;
  total_conversations: number;
  companies_with_ai_off: number;
  companies_with_email_crawl_off: number;
};

export type PortalLoginRoles = {
  ceo: number;
  head: number;
  employee: number;
  platform_admin: number;
};

export type CompanyRow = {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  user_count: number;
  employee_count: number;
  portal_login_roles?: PortalLoginRoles;
};

export type CompanyDetail = {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  users: Array<{
    id: string;
    email: string;
    full_name: string | null;
    role: string;
    created_at: string;
    linked_employee_id: string | null;
  }>;
  employees: Array<{
    id: string;
    name: string;
    email: string;
    mailbox_type: string | null;
    gmail_status: string | null;
    is_active: boolean;
    ai_enabled: boolean;
    tracking_paused: boolean;
    tracking_start_at: string | null;
    last_synced_at: string | null;
    department_name: string | null;
    conversation_count: number;
    message_count: number;
  }>;
  ai_usage: {
    ai_classified_messages: number;
    ai_enriched_conversations: number;
    ai_quota_fallback_messages: number;
    historical_search_runs: number;
    last_historical_search_at: string | null;
  };
  totals: {
    users: number;
    employees: number;
    active_mailboxes: number;
    connected_mailboxes: number;
    conversations: number;
    messages: number;
    departments: number;
  };
};

export type BillingOverview = {
  currency: { usd_to_inr: number };
  rates: {
    gemini_input_usd_per_1m: number;
    gemini_output_usd_per_1m: number;
    storage_usd_per_gb_month: number;
    backfill_calibration: number;
  };
  period: { from: string; to: string };
  metering: {
    disclaimer: string;
    metered_since: string | null;
    live_api_calls: number;
    estimated_backfill_calls: number;
    storage_note: string;
    calibration_note: string;
  };
  platform_totals: {
    api_calls: number;
    total_tokens: number;
    api_cost_usd: number;
    api_cost_inr: number;
    live_api_calls: number;
    estimated_api_calls: number;
    live_api_cost_inr: number;
    estimated_api_cost_inr: number;
    storage_bytes: number;
    storage_cost_usd: number;
    storage_cost_inr: number;
    total_cost_usd: number;
    total_cost_inr: number;
  };
  companies: CompanyBillingRow[];
};

export type CompanyBillingRow = {
  company_id: string;
  company_name: string;
  api_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  api_cost_usd: number;
  api_cost_inr: number;
  live_api_calls: number;
  estimated_api_calls: number;
  live_api_cost_inr: number;
  estimated_api_cost_inr: number;
  storage_bytes: number;
  storage_gb: number;
  storage_cost_usd: number;
  storage_cost_inr: number;
  total_cost_usd: number;
  total_cost_inr: number;
  message_count: number;
  conversation_count: number;
  employee_count: number;
};
