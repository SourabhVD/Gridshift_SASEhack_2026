/** Error thrown by every GridShift API call, mock or real. */
export class ApiError extends Error {
  /**
   * HTTP status, or the status the mock server is imitating.
   * `0` means the request never got an HTTP answer: the fetch threw, or it hit
   * the client-side timeout in src/lib/api.ts.
   */
  readonly status: number;
  /** Endpoint that failed, for logging. */
  readonly endpoint: string;

  constructor(status: number, endpoint: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/**
 * The backend answered 2xx with a body that is not the documented payload --
 * e.g. `/api/forecast` without `points`. Treated exactly like an unimplemented
 * endpoint in 'partial' mode (fall back to the mock), and surfaced like any
 * other ApiError otherwise.
 */
export class ApiShapeError extends ApiError {
  constructor(status: number, endpoint: string, missing: string) {
    super(status, endpoint, `${endpoint} returned an unexpected shape (${missing}).`);
    this.name = 'ApiShapeError';
  }
}

/** Narrow an unknown caught value to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
