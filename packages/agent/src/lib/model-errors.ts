/** A failed model response, independent of HTTP versus SSE transport. */
export class ModelRequestError extends Error {
  override readonly name = 'ModelRequestError';

  constructor(
    message: string,
    readonly details: {
      source: 'http' | 'response';
      code?: string | undefined;
      status?: number | undefined;
      responseId?: string | undefined;
      requestId?: string | undefined;
      errorType?: string | undefined;
      retryAfterMs?: number | undefined;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  get status() {
    return this.details.status;
  }
  get code() {
    return this.details.code;
  }
  get responseId() {
    return this.details.responseId;
  }
  get requestId() {
    return this.details.requestId;
  }
  get recoverable() {
    return isRetryableModelError(this);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Keep structured provider diagnostics instead of replacing them with "Response failed". */
export function modelResponseError(value: unknown): ModelRequestError | undefined {
  const response = record(value);
  if (
    !response ||
    (!response['error'] && response['status'] !== 'failed' && response['status'] !== 'cancelled')
  ) {
    return;
  }
  const error = record(response['error']);
  const code = error?.['code'];
  const status =
    typeof code === 'number'
      ? code
      : typeof code === 'string' && /^\d{3}$/.test(code)
        ? Number(code)
        : undefined;
  return new ModelRequestError(
    text(error?.['message']) ?? `Model response ${response['status'] ?? 'failed'}`,
    {
      source: 'response',
      code: typeof code === 'number' ? String(code) : text(code),
      status,
      responseId: text(response['id']),
      requestId: text(response['requestId'] ?? response['request_id']),
      errorType: text(response['errorType'] ?? response['error_type']),
      retryAfterMs:
        typeof error?.['retry_after_ms'] === 'number' &&
        Number.isFinite(error['retry_after_ms']) &&
        error['retry_after_ms'] > 0
          ? error['retry_after_ms']
          : undefined,
    },
  );
}

/** Normalize SDK HTTP errors, including an error-only JSON body returned with HTTP 200. */
export function normalizeModelError(value: unknown): ModelRequestError {
  if (value instanceof ModelRequestError) {
    return value;
  }
  const error = record(value);
  const raw = error?.['rawValue'];
  let body: unknown = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      /* A malformed body is not a retryable provider response. */
    }
  }
  const data = record(error?.['error']);
  const code = data?.['code'];
  const response = record(error?.['rawResponse'] ?? error?.['response']);
  const status = error?.['statusCode'] ?? error?.['status'] ?? response?.['status'];
  const headers = error?.['headers'] ?? response?.['headers'];
  const requestId =
    headers instanceof Headers
      ? (headers.get('x-request-id') ?? headers.get('request-id') ?? undefined)
      : undefined;
  const responseFailure = modelResponseError(body);
  if (responseFailure) {
    return new ModelRequestError(
      responseFailure.message,
      {
        ...responseFailure.details,
        // A malformed error body from a non-2xx HTTP request has already gone
        // through transport recovery. Never mistake it for an HTTP-200 failure.
        ...(typeof status === 'number' && status >= 400
          ? {
              source: 'http' as const,
              status,
            }
          : {}),
        requestId: responseFailure.requestId ?? requestId,
      },
      {
        cause: value,
      },
    );
  }
  return new ModelRequestError(
    text(data?.['message']) ?? text(error?.['message']) ?? String(value),
    {
      source: 'http',
      status: typeof status === 'number' ? status : undefined,
      code: code === undefined || code === null ? undefined : String(code),
      requestId: text(error?.['requestId'] ?? error?.['request_id']) ?? requestId ?? undefined,
    },
    {
      cause: value,
    },
  );
}

/** Classification is shared with callers; only response errors are retried by the agent. */
export function isRetryableModelError(value: unknown): boolean {
  const error = value instanceof ModelRequestError ? value : normalizeModelError(value);
  const { status, code, errorType } = error.details;
  if (
    code &&
    /invalid|content_policy|content_filter|context_length|insufficient|unauthorized|forbidden|cancel/i.test(
      code,
    )
  ) {
    return false;
  }
  if (status !== undefined) {
    return (
      [
        408,
        409,
        425,
        429,
      ].includes(status) || status >= 500
    );
  }
  return (
    /^(server_error|rate_limit_exceeded|vector_store_timeout|provider_unavailable|provider_overloaded|timeout|upstream_error)$/.test(
      code ?? '',
    ) ||
    /^(provider_unavailable|provider_overloaded|rate_limited|timeout)$/.test(errorType ?? '') ||
    (error.details.source === 'http' &&
      /response failed|rate.?limit|timeout|timed out|econnreset|econnrefused|fetch failed|network|socket|temporar/i.test(
        error['message'],
      ))
  );
}

export type ModelRetryEvent = {
  error: ModelRequestError;
  /** The retry about to be made, starting at 1. */
  attempt: number;
  delayMs: number;
};

/** Backoff must stop promptly on cancellation or the model-request deadline. */
export function waitForModelRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, {
      once: true,
    });
  });
}
