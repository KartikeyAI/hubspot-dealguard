import { AppError } from './errors.js';
import type { Env, RequestIdentity } from './types.js';

const encoder = new TextEncoder();
const MAX_AGE_MS = 5 * 60 * 1000;
const URI_DECODINGS: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

function decodeHubSpotUri(uri: string): string {
  let decoded = uri;
  for (const [encoded, value] of Object.entries(URI_DECODINGS)) {
    decoded = decoded.replaceAll(encoded, value).replaceAll(encoded.toLowerCase(), value);
  }
  return decoded;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const max = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < max; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

async function hmacBase64(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const result = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  let binary = '';
  for (const byte of result) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateHubSpotRequest(request: Request, env: Env): Promise<RequestIdentity> {
  const url = new URL(request.url);
  const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  const signatureV3 = request.headers.get('x-hubspot-signature-v3');
  const timestampHeader = request.headers.get('x-hubspot-request-timestamp');

  let valid = false;
  if (signatureV3 && timestampHeader) {
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_AGE_MS) {
      throw new AppError(401, 'expired_signature', 'HubSpot request timestamp is outside the accepted window.');
    }
    const source = `${request.method.toUpperCase()}${decodeHubSpotUri(request.url)}${rawBody}${timestampHeader}`;
    const expected = await hmacBase64(env.HUBSPOT_CLIENT_SECRET, source);
    valid = constantTimeEqual(expected, signatureV3);
  } else {
    const legacySignature = request.headers.get('x-hubspot-signature');
    const version = request.headers.get('x-hubspot-signature-version')?.toLowerCase();
    if (legacySignature && version === 'v2') {
      const expected = await sha256Hex(`${env.HUBSPOT_CLIENT_SECRET}${request.method.toUpperCase()}${request.url}${rawBody}`);
      valid = constantTimeEqual(expected, legacySignature);
    } else if (legacySignature && version === 'v1') {
      const expected = await sha256Hex(`${env.HUBSPOT_CLIENT_SECRET}${rawBody}`);
      valid = constantTimeEqual(expected, legacySignature);
    }
  }

  if (!valid) throw new AppError(401, 'invalid_signature', 'The request signature could not be verified.');

  const portalId = url.searchParams.get('portalId');
  if (!portalId || !/^\d+$/.test(portalId)) {
    throw new AppError(401, 'missing_portal_identity', 'HubSpot portal identity is missing.');
  }
  const appId = url.searchParams.get('appId');
  if (env.HUBSPOT_APP_ID && env.HUBSPOT_APP_ID !== 'REPLACE_WITH_HUBSPOT_APP_ID' && appId && appId !== env.HUBSPOT_APP_ID) {
    throw new AppError(401, 'app_identity_mismatch', 'HubSpot app identity does not match this installation.');
  }

  return {
    portalId,
    userId: url.searchParams.get('userId'),
    userEmail: url.searchParams.get('userEmail'),
    appId,
  };
}
