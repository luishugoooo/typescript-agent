/** A failed model response, independent of HTTP versus SSE transport. */
export declare class ModelRequestError extends Error {
    readonly details: {
        source: 'http' | 'response';
        code?: string | undefined;
        status?: number | undefined;
        responseId?: string | undefined;
        requestId?: string | undefined;
        errorType?: string | undefined;
        retryAfterMs?: number | undefined;
    };
    readonly name = "ModelRequestError";
    constructor(message: string, details: {
        source: 'http' | 'response';
        code?: string | undefined;
        status?: number | undefined;
        responseId?: string | undefined;
        requestId?: string | undefined;
        errorType?: string | undefined;
        retryAfterMs?: number | undefined;
    }, options?: ErrorOptions);
    get status(): number | undefined;
    get code(): string | undefined;
    get responseId(): string | undefined;
    get requestId(): string | undefined;
    get recoverable(): boolean;
}
/** Keep structured provider diagnostics instead of replacing them with "Response failed". */
export declare function modelResponseError(value: unknown): ModelRequestError | undefined;
/** Normalize SDK HTTP errors, including an error-only JSON body returned with HTTP 200. */
export declare function normalizeModelError(value: unknown): ModelRequestError;
/** Classification is shared with callers; only response errors are retried by the agent. */
export declare function isRetryableModelError(value: unknown): boolean;
export type ModelRetryEvent = {
    error: ModelRequestError;
    /** The retry about to be made, starting at 1. */
    attempt: number;
    delayMs: number;
};
/** Backoff must stop promptly on cancellation or the model-request deadline. */
export declare function waitForModelRetry(delayMs: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=model-errors.d.ts.map