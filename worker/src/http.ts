import { APP_VERSION } from './config.js';
import { AppError, asAppError } from './errors.js';

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://app.hubspot.com https://app-eu1.hubspot.com",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-dealguard-version': APP_VERSION,
    ...SECURITY_HEADERS,
  });
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

export function html(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...SECURITY_HEADERS,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://app.hubspot.com https://app-eu1.hubspot.com; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export function redirect(location: string, status = 302, headersInit: HeadersInit = {}): Response {
  const headers = new Headers(headersInit);
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(null, { status, headers });
}

export async function readJson<T>(request: Request, maxBytes = 64_000): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) throw new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.');
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body must contain valid JSON.');
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const appError = asAppError(error);
  return json(
    {
      error: {
        code: appError.code,
        message: appError.status >= 500 ? 'DealGuard could not complete the request.' : appError.message,
        requestId,
        ...(appError.status < 500 && appError.details !== undefined ? { details: appError.details } : {}),
      },
    },
    appError.status,
  );
}

export function requestId(request: Request): string {
  return request.headers.get('cf-ray') ?? crypto.randomUUID();
}

export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, 405, {
    allow: allowed.join(', '),
  });
}
