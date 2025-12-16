export type RetryOptions = {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, info: { attempt: number; delayMs: number }) => void;
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const retry = async <T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> => {
  const {
    retries = 2,
    initialDelayMs = 400,
    maxDelayMs = 4000,
    factor = 2,
    jitter = 0.2,
    shouldRetry,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const canRetry = attempt < retries && (shouldRetry ? shouldRetry(error) : true);
      if (!canRetry) {
        throw error;
      }

      const baseDelay = initialDelayMs * Math.pow(factor, attempt);
      const cappedDelay = Math.min(baseDelay, maxDelayMs);
      const jitterOffset = cappedDelay * jitter * (Math.random() * 2 - 1);
      const delayMs = Math.max(0, Math.round(cappedDelay + jitterOffset));

      onRetry?.(error, { attempt: attempt + 1, delayMs });
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};
