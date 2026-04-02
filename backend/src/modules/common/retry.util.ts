export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  factor?: number;
  maxDelayMs?: number;
  operationName?: string;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const defaultShouldRetry = () => true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 8000;
  const factor = options.factor ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const label = options.operationName ?? 'operation';
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(operation(), timeoutMs, label);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;
      const delayMs = Math.min(maxDelayMs, Math.round(baseDelayMs * Math.pow(factor, attempt - 1)));
      options.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}
