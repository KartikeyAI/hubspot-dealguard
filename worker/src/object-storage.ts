import { AwsClient } from 'aws4fetch';
import { AppError } from './errors.js';
import type { Env } from './types.js';

const DEFAULT_ENDPOINT = 'https://t3.storage.dev';
const MAX_SIGNED_URL_SECONDS = 15 * 60;

interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function configuration(env: Env): ObjectStorageConfig {
  const endpoint = env.TIGRIS_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  const region = env.TIGRIS_REGION?.trim() || 'auto';
  const bucket = env.TIGRIS_BUCKET?.trim();
  const accessKeyId = env.TIGRIS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.TIGRIS_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new AppError(503, 'object_storage_not_configured', 'Tigris object storage is not configured for this deployment.');
  }
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

function safePart(value: string): string {
  return value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'object';
}

function objectUrl(config: ObjectStorageConfig, key: string): URL {
  const endpoint = new URL(config.endpoint);
  const keyPath = `/${config.bucket}/${key}`.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(keyPath, `${endpoint.origin}/`);
}

function signedClient(config: ObjectStorageConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
  });
}

async function signRequest(
  config: ObjectStorageConfig,
  method: string,
  url: URL,
  body: string | Uint8Array | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<Headers> {
  const client = signedClient(config);
  const requestInit: RequestInit = {
    method,
    headers: extraHeaders,
  };
  if (typeof body === 'string') {
    requestInit.body = new TextEncoder().encode(body);
  } else if (body instanceof Uint8Array) {
    requestInit.body = body as unknown as BodyInit;
  }
  const request = new Request(url, requestInit);
  const signedRequest = await client.sign(request);
  return signedRequest.headers;
}

async function presignUrl(
  config: ObjectStorageConfig,
  key: string,
  method: string,
  expiresSeconds: number,
  queryParams: Record<string, string> = {},
): Promise<string> {
  const url = objectUrl(config, key);
  url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(MAX_SIGNED_URL_SECONDS, expiresSeconds))));
  for (const [name, value] of Object.entries(queryParams)) {
    url.searchParams.set(name, value);
  }
  const client = signedClient(config);
  const signedRequest = await client.sign(url, {
    method,
    aws: {
      service: 's3',
      region: config.region,
      signQuery: true,
      allHeaders: false,
      singleEncode: true,
    },
  });
  return signedRequest.url.toString();
}

export function tenantObjectKey(portalId: string, category: string, id: string, filename: string): string {
  if (!/^\d+$/.test(portalId)) throw new AppError(400, 'portal_id_invalid', 'Portal identifier is invalid.');
  return `portals/${portalId}/${safePart(category)}/${safePart(id)}/${safePart(filename)}`;
}

export async function createSignedObjectUpload(
  env: Env,
  input: { key: string; contentType: string; contentLength: number; sha256: string; expiresSeconds?: number },
): Promise<string> {
  const config = configuration(env);
  return presignUrl(config, input.key, 'PUT', Math.min(MAX_SIGNED_URL_SECONDS, Math.max(60, input.expiresSeconds ?? 600)), {
    'Content-Type': input.contentType,
    'Content-Length': String(input.contentLength),
    'x-amz-meta-sha256': input.sha256,
  });
}

export async function headObject(env: Env, key: string): Promise<{ contentLength: number; contentType: string | null; etag: string | null; sha256: string | null }> {
  const config = configuration(env);
  const url = objectUrl(config, key);
  const headers = await signRequest(config, 'HEAD', url, undefined, { accept: '*/*' });
  const response = await fetch(url, { method: 'HEAD', headers });
  if (response.status === 404) throw new AppError(409, 'object_upload_incomplete', 'The uploaded object is not available yet.');
  if (!response.ok) throw new AppError(502, 'object_storage_request_failed', `Tigris HEAD request failed with status ${response.status}.`);

  return {
    contentLength: Number(response.headers.get('content-length') ?? 0),
    contentType: response.headers.get('content-type') ?? null,
    etag: response.headers.get('etag')?.replaceAll('"', '') ?? null,
    sha256: response.headers.get('x-amz-meta-sha256')?.toLowerCase() ?? null,
  };
}

export async function putObject(
  env: Env,
  input: { key: string; body: string | Uint8Array; contentType: string; sha256: string },
): Promise<{ etag: string | null; sizeBytes: number }> {
  const config = configuration(env);
  const url = objectUrl(config, input.key);
  const bytes = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : new Uint8Array(input.body);
  const headers = await signRequest(config, 'PUT', url, bytes, {
    'content-type': input.contentType,
    'content-length': String(bytes.byteLength),
    'x-amz-meta-sha256': input.sha256,
  });
  const response = await fetch(url, { method: 'PUT', headers, body: bytes });
  if (!response.ok) throw new AppError(502, 'object_storage_request_failed', `Tigris PUT request failed with status ${response.status}.`);
  return { etag: response.headers.get('etag')?.replaceAll('"', '') ?? null, sizeBytes: bytes.byteLength };
}

export async function createSignedObjectDownload(env: Env, key: string, filename?: string, expiresSeconds = 300): Promise<string> {
  const config = configuration(env);
  const queryParams: Record<string, string> = {};
  if (filename) queryParams['response-content-disposition'] = `attachment; filename="${safePart(filename)}"`;
  return presignUrl(config, key, 'GET', Math.min(MAX_SIGNED_URL_SECONDS, Math.max(60, expiresSeconds)), queryParams);
}

export async function deleteTenantObjects(env: Env, portalId: string): Promise<number> {
  const config = configuration(env);
  const prefix = `portals/${portalId}/`;
  let continuationToken: string | undefined;
  let deleted = 0;

  do {
    const listUrl = objectUrl(config, '');
    const listParams = new URLSearchParams({ 'list-type': '2', prefix });
    if (continuationToken) listParams.set('continuation-token', continuationToken);
    listUrl.search = listParams.toString();
    const listHeaders = await signRequest(config, 'GET', listUrl, undefined, { accept: '*/*' });
    const listResponse = await fetch(listUrl, { method: 'GET', headers: listHeaders });
    if (!listResponse.ok) throw new AppError(502, 'object_storage_request_failed', `Tigris LIST request failed with status ${listResponse.status}.`);

    const xml = await listResponse.text();
    const keys = Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g)).map((match) => match[1]);
    if (keys.length) {
      const deleteBody = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys.map((key) => `<Object><Key>${key}</Key></Object>`).join('')}</Delete>`;
      const deleteUrl = objectUrl(config, '');
      deleteUrl.search = '?delete';
      const deleteHeaders = await signRequest(config, 'POST', deleteUrl, deleteBody, {
        'content-type': 'application/xml',
        'content-length': String(deleteBody.length),
      });
      const deleteResponse = await fetch(deleteUrl, { method: 'POST', headers: deleteHeaders, body: deleteBody });
      if (!deleteResponse.ok) throw new AppError(502, 'object_storage_request_failed', `Tigris DELETE request failed with status ${deleteResponse.status}.`);
      deleted += keys.length;
    }

    const nextToken = new RegExp('<NextContinuationToken>([^<]+)</NextContinuationToken>').exec(xml)?.[1];
    continuationToken = nextToken || undefined;
  } while (continuationToken);

  return deleted;
}
