/** Error thrown by every GridShift API call, mock or real. */
export class ApiError extends Error {
  /** HTTP status, or the status the mock server is imitating. */
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

/** Narrow an unknown caught value to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
