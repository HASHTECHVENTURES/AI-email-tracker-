import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiApiKeyFromEnv } from './env';

export function isGeminiQuotaError(message: string): boolean {
  return /\b429\b|quota|Quota|rate|Rate|resource_exhausted|spending\s+cap|spend\s+cap|exceeded its/i.test(
    message,
  );
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
    if (isGeminiQuotaError(msg)) return 'quota';
    return 'error';
  }
}
