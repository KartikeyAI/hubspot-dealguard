export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const INTERNAL_ERROR_PATTERNS = [
  /relation\s+["'`]?[^\s"'`]+["'`]?\s+does not exist/i,
  /column\s+["'`]?[^\s"'`]+["'`]?\s+does not exist/i,
  /table\s+["'`]?[^\s"'`]+["'`]?/i,
  /postgres(?:ql)?/i,
  /neon/i,
  /cloudflare/i,
  /dodo(?:\s+payments)?/i,
  /sqlstate/i,
  /syntax error at or near/i,
  /violates .* constraint/i,
  /duplicate key value/i,
  /database/i,
  /stack trace/i,
  /worker\/src\//i,
];

export function containsInternalImplementationDetail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(value));
}

export function publicErrorMessage(error: AppError): string {
  if (error.status >= 500 || containsInternalImplementationDetail(error.message)) {
    return 'DealGuard could not complete the request. Please try again.';
  }
  return error.message;
}

export function publicErrorDetails(error: AppError): unknown | undefined {
  if (error.status >= 500 || error.details === undefined) return undefined;
  const serialized = (() => {
    try { return JSON.stringify(error.details); } catch { return ''; }
  })();
  return containsInternalImplementationDetail(serialized) ? undefined : error.details;
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError(500, 'internal_error', 'DealGuard could not complete the request.');
  return new AppError(500, 'internal_error', 'DealGuard could not complete the request.');
}
