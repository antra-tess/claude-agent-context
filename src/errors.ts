export type GenerationErrorKind = 'api' | 'network' | 'timeout' | 'abort' | 'protocol' | 'callback' | 'sdk';

/** Transport errors retain the provider's status, error type, body, and retry hints. */
export class GenerationError extends Error {
  constructor(message: string, readonly kind: GenerationErrorKind, readonly details: {
    status?: number;
    code?: string;
    headers?: Record<string, string>;
    body?: unknown;
    request?: unknown;
    retryAfterMs?: number;
    phase?: 'total' | 'first-event' | 'idle';
    cause?: unknown;
  } = {}) {
    super(message, { cause: details.cause });
    this.name = 'GenerationError';
  }
  get status() { return this.details.status; }
  get code() { return this.details.code; }
  get retryAfterMs() { return this.details.retryAfterMs; }
  get retryable() {
    return this.kind === 'network' || this.kind === 'timeout' ||
      (this.kind === 'api' && (this.status === 429 || (this.status ?? 0) >= 500));
  }
}

const statuses: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, permission_error: 403,
  not_found_error: 404, request_too_large: 413, rate_limit_error: 429,
  api_error: 500, overloaded_error: 529,
};

export function apiError(body: any, status?: number, headers: Record<string, string> = {}, request?: unknown): GenerationError {
  const error = body?.error ?? body;
  const code = typeof error?.type === 'string' ? error.type : undefined;
  const retry = headers['retry-after'];
  let retryAfterMs: number | undefined;
  if (headers['retry-after-ms'] && Number.isFinite(Number(headers['retry-after-ms']))) retryAfterMs = Math.max(0, Number(headers['retry-after-ms']));
  else if (retry && Number.isFinite(Number(retry))) retryAfterMs = Math.max(0, Number(retry) * 1000);
  else if (retry && Number.isFinite(Date.parse(retry))) retryAfterMs = Math.max(0, Date.parse(retry) - Date.now());
  return new GenerationError(typeof error?.message === 'string' ? error.message : `Messages API error (${status ?? code ?? 'unknown'})`, 'api', {
    status: code && (status === undefined || status < 400) ? statuses[code] : status,
    code, headers, body, request, retryAfterMs,
  });
}
