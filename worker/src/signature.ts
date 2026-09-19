import { AppError } from './errors.js';
import type { Env, RequestIdentity } from './types.js';

const encoder = new TextEncoder();
const MAX_AGE_MS = 5 * 60 * 1000;
const URI_DECODINGS: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$', '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

function decodeHubSpotUri(uri: string): string {
  let decoded = uri;
  for (const [encoded, value] of Object.entries(URI_DECODINGS)) decoded = decoded.replaceAll(encoded, value).replaceAll(encoded.toLowerCase(), value);
  return decoded;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const max = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < max; index += 1) mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return mismatch === 0;
}

async function hmacBase64(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const result = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  let binary = '';
  for (const byte of result) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateHubSpotSignature(request: Request, env: Env, requireUrlBinding = false): Promise<void> {
  if (!env.HUBSPOT_CLIENT_SECRET) throw new AppError(401, 'signature_unavailable', 'Request authentication is not configured.');
  const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  const signatureV3 = request.headers.get('x-hubspot-signature-v3');
  const timestampHeader = request.headers.get('x-hubspot-request-timestamp');
  let valid = false;
  if (signatureV3 !== null || timestampHeader !== null) {
    if (!signatureV3 || !timestampHeader || !/^[0-9]{10,16}$/.test(timestampHeader) || !/^[A-Za-z0-9+/]{43}=$/.test(signatureV3)) throw new AppError(401, 'invalid_signature', 'Complete, valid HubSpot v3 signature headers are required.');
    const timestamp = Number(timestampHeader);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_AGE_MS) throw new AppError(401, 'expired_signature', 'HubSpot request timestamp is outside the accepted window.');
    const source = `${request.method.toUpperCase()}${decodeHubSpotUri(request.url)}${rawBody}${timestampHeader}`;
    valid = constantTimeEqual(await hmacBase64(env.HUBSPOT_CLIENT_SECRET, source), signatureV3);
  } else {
    const legacySignature = request.headers.get('x-hubspot-signature');
    const version = request.headers.get('x-hubspot-signature-version')?.toLowerCase();
    if (legacySignature && version === 'v2') valid = constantTimeEqual(await sha256Hex(`${env.HUBSPOT_CLIENT_SECRET}${request.method.toUpperCase()}${request.url}${rawBody}`), legacySignature);
    else if (!requireUrlBinding && legacySignature && version === 'v1') valid = constantTimeEqual(await sha256Hex(`${env.HUBSPOT_CLIENT_SECRET}${rawBody}`), legacySignature);
  }
  if (!valid) throw new AppError(401, 'invalid_signature', 'The request signature could not be verified.');
}

/** UI identities come from the URL, so body-only v1 signatures are never sufficient. */
export async function validateHubSpotRequest(request: Request, env: Env): Promise<RequestIdentity> {
  await validateHubSpotSignature(request, env, true);
  const url = new URL(request.url);
  const unique = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || values.some(value => !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))) {
      throw new AppError(401, 'ambiguous_request_identity', 'HubSpot request identity is invalid or ambiguous.');
    }
    return values[0] ?? null;
  };
  const portalId = unique('portalId'), appId = unique('appId'), userId = unique('userId'), userEmail = unique('userEmail');
  if (!portalId || !/^[1-9]\d{0,29}$/.test(portalId)) throw new AppError(401, 'missing_portal_identity', 'HubSpot portal identity is missing or invalid.');
  if (appId && !/^[1-9]\d{0,29}$/.test(appId)) throw new AppError(401, 'app_identity_mismatch', 'HubSpot project identity is invalid.');
  if (env.HUBSPOT_APP_ID && /^[1-9]\d{0,29}$/.test(env.HUBSPOT_APP_ID) && appId !== env.HUBSPOT_APP_ID) {
    throw new AppError(401, 'app_identity_mismatch', 'HubSpot project identity does not match this installation.');
  }
  if (userId && !/^[1-9]\d{0,29}$/.test(userId)) throw new AppError(401, 'invalid_user_identity', 'HubSpot user identity is invalid.');
  if (userEmail && (userEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail))) {
    throw new AppError(401, 'invalid_user_identity', 'HubSpot user identity is invalid.');
  }
  return { portalId, userId, userEmail, appId };
}
