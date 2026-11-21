import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';
import { readBoundedText } from './request-body.js';
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
  await requireTenantObjectWrite(env, input.key);
  const url = await presignUrl(config, input.key, 'PUT', Math.min(MAX_SIGNED_URL_SECONDS, Math.max(60, input.expiresSeconds ?? 600)), {
    'Content-Type': input.contentType,
    'Content-Length': String(input.contentLength),
    'x-amz-meta-sha256': input.sha256,
  });
  await requireTenantObjectWrite(env, input.key);
  return url;
}

async function requireTenantObjectWrite(env: Env, key: string): Promise<void> {
  const portalId = /^portals\/([0-9]+)\//.exec(key)?.[1];
  if (!portalId) return;
  const tenant = await env.DB.prepare('SELECT status FROM tenants WHERE portal_id=?').bind(portalId).first<{status: string}>();
  if (tenant?.status !== 'active') throw new AppError(409, 'installation_inactive', 'This installation is not accepting stored files.');
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
  await requireTenantObjectWrite(env, input.key);
  const response = await fetch(url, { method: 'PUT', headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new AppError(502, 'object_storage_request_failed', `Tigris PUT request failed with status ${response.status}.`);
  return { etag: response.headers.get('etag')?.replaceAll('"', '') ?? null, sizeBytes: bytes.byteLength };
}

export async function createSignedObjectDownload(env: Env, key: string, filename?: string, expiresSeconds = 300): Promise<string> {
  const config = configuration(env);
  const queryParams: Record<string, string> = {};
  if (filename) queryParams['response-content-disposition'] = `attachment; filename="${safePart(filename)}"`;
  return presignUrl(config, key, 'GET', Math.min(MAX_SIGNED_URL_SECONDS, Math.max(60, expiresSeconds)), queryParams);
}

function invalidDeletionResponse(): never {
  throw new AppError(502, 'object_storage_deletion_response_invalid', 'Object storage returned an invalid deletion response.');
}

function xmlText(value: string): string {
  if (/&(?!amp;|lt;|gt;|apos;|quot;|#\d+;|#x[0-9a-fA-F]+;)/.test(value)) return invalidDeletionResponse();
  return value.replace(/&(amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);/g, (_all, entity: string) => {
    const known: Record<string,string> = {amp:'&',lt:'<',gt:'>',apos:"'",quot:'"'};
    if (known[entity] !== undefined) return known[entity]!;
    const point = entity.startsWith('#x') ? Number.parseInt(entity.slice(2),16) : Number.parseInt(entity.slice(1),10);
    if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return invalidDeletionResponse();
    return String.fromCodePoint(point);
  });
}

function xmlElement(xml: string, name: string): string | null {
  const values = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  if (values.length > 1) return invalidDeletionResponse();
  return values[0]?.[1] ?? null;
}

function xmlDocument(xml: string, root: string): boolean {
  if (/<!DOCTYPE|<!ENTITY|<Error\b/i.test(xml)) return false;
  const body = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim();
  return new RegExp(`^<${root}(?:\\s[^>]*)?>[\\s\\S]*</${root}>$`).test(body)
    || new RegExp(`^<${root}(?:\\s[^>]*)?\\s*/>$`).test(body);
}

/** Delete bounded first-page batches. Relisting avoids a cursor into a changing
 * prefix; a separate empty listing is required before reporting completion. */
export async function deleteTenantObjects(env: Env, portalId: string, options: {
  beforeRequest(): Promise<void>; maxPasses?: number;
}): Promise<{ deleted: number; complete: boolean }> {
  if (!/^[0-9]{1,32}$/.test(portalId)) throw new AppError(400, 'portal_id_invalid', 'Portal identifier is invalid.');
  const config = configuration(env);
  const prefix = `portals/${portalId}/`;
  let deleted = 0;
  const deadlineAt = Date.now()+45_000;
  const maxPasses = Number.isSafeInteger(options.maxPasses) ? Math.max(1,Math.min(3,options.maxPasses!)) : 3;
  const request = async(url: URL, method: 'GET' | 'POST', body?: string, extraHeaders: Record<string,string> = {}): Promise<string> => {
    const headers = await signRequest(config, method, url, body, extraHeaders);
    await options.beforeRequest();
    const remaining = Math.min(10_000,deadlineAt-Date.now());
    if (remaining <= 0) throw new AppError(502, 'object_storage_request_failed', 'Object deletion will resume on its next attempt.');
    const signal = AbortSignal.timeout(remaining);
    const response = await fetch(url,{method,headers,...(body ? {body} : {}),redirect:'error',signal});
    if (!response.ok) throw new AppError(502, 'object_storage_request_failed', 'Object storage could not complete the deletion attempt.');
    try { return await readBoundedText({headers:response.headers,body:response.body,signal},1_048_576,remaining); }
    catch { return invalidDeletionResponse(); }
  };
  for (let pass=0;pass<maxPasses;pass++) {
    const listUrl = objectUrl(config, '');
    listUrl.search = new URLSearchParams({'list-type':'2',prefix,'max-keys':'200','encoding-type':'url'}).toString();
    const xml = await request(listUrl,'GET',undefined,{accept:'application/xml'});
    if (!xmlDocument(xml,'ListBucketResult') || /<CommonPrefixes\b/.test(xml)) return invalidDeletionResponse();
    const truncated = xmlElement(xml,'IsTruncated');
    if (truncated !== 'true' && truncated !== 'false') return invalidDeletionResponse();
    const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
    if ((xml.match(/<Contents\b/g)??[]).length !== contents.length || (xml.match(/<Key>/g)??[]).length !== contents.length || contents.length>200) return invalidDeletionResponse();
    const encoding = xmlElement(xml,'EncodingType');
    if (encoding !== null && encoding !== 'url') return invalidDeletionResponse();
    const keys = contents.map(content => {
      const value = xmlElement(content[1]!,'Key');
      if (value === null) return invalidDeletionResponse();
      let key: string;
      try { key = encoding === 'url' ? decodeURIComponent(xmlText(value)) : xmlText(value); } catch { return invalidDeletionResponse(); }
      if (!key.startsWith(prefix) || new TextEncoder().encode(key).byteLength>1024 || /[\u0000-\u001f\u007f]/.test(key)) return invalidDeletionResponse();
      return key;
    });
    const count = xmlElement(xml,'KeyCount');
    if (count === null || !/^\d+$/.test(count) || Number(count)!==keys.length) return invalidDeletionResponse();
    if (keys.length===0) {
      if (truncated==='true') return invalidDeletionResponse();
      return {deleted,complete:true};
    }
    const escape = (key: string) => key.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
    const deleteBody = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys.map(key=>`<Object><Key>${escape(key)}</Key></Object>`).join('')}</Delete>`;
    const deleteUrl = objectUrl(config,''); deleteUrl.search='?delete';
    const result = await request(deleteUrl,'POST',deleteBody,{'content-type':'application/xml',
      'content-length':String(new TextEncoder().encode(deleteBody).byteLength),'content-md5':createHash('md5').update(deleteBody).digest('base64')});
    // S3 can return HTTP 200 with per-key errors, including in quiet mode.
    if (!xmlDocument(result,'DeleteResult')) return invalidDeletionResponse();
    deleted+=keys.length;
  }
  return {deleted,complete:false};
}
