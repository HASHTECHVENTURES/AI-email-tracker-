import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiApiKeyFromEnv } from './env';

/**
 * True only when Gemini reports the monthly spend cap is actually hit.
 * Avoid broad matches (e.g. "billing" in generic 429 text) that falsely halt sync.
 */
export function isGeminiMonthlyQuotaExhausted(message: string): boolean {
  const m = message.toLowerCase();
  if (/exceeded its/.test(m)) return true;
  if (/spend(ing)?\s+cap/.test(m) && /exceed|reached|hit|over|limit/.test(m)) return true;
  if (/monthly/.test(m) && /quota|limit/.test(m) && /exceed/.test(m)) return true;
  return false;
}

/** Transient RPM/RPD rate limit — retry, do NOT halt the whole system. */
export function isGeminiTransientRateLimit(message: string): boolean {
  return /\b429\b|resource_exhausted|rate.?limit|too many requests/i.test(message);
}

/** @deprecated Use isGeminiMonthlyQuotaExhausted for halt decisions. */
export function isGeminiQuotaError(message: string): boolean {
  return isGeminiMonthlyQuotaExhausted(message) || isGeminiTransientRateLimit(message);
}

/** Lightweight Gemini ping — used to auto-clear the quota gate after credits are renewed. */
export async function probeGeminiQuotaAvailable(): Promise<'ok' | 'quota' | 'unconfigured' | 'error'> {
  const key = getGeminiApiKeyFromEnv();
  if (!key) return 'unconfigured';

  const genAI = new GoogleGenerativeAI(key);
  const modelName = process.env.GEMINI_RELEVANCE_MODEL?.trim() || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  try {
    const result = await model.generateContent('Reply with OK');
    void result.response.text();
    return 'ok';
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (isGeminiMonthlyQuotaExhausted(msg)) return 'quota';
    return 'error';
  }
}
