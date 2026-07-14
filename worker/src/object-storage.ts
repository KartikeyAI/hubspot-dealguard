import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from './errors.js';
import type { Env } from './types.js';

const DEFAULT_ENDPOINT = 'https://t3.storage.dev';
const MAX_SIGNED_URL_SECONDS = 15 * 60;

function configuration(env: Env) {
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

function client(env: Env): { client: S3Client; bucket: string } {
  const config = configuration(env);
  return {
    bucket: config.bucket,
    client: new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }),
  };
}

function safePart(value: string): string {
  return value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'object';
}

export function tenantObjectKey(portalId: string, category: string, id: string, filename: string): string {
  if (!/^\d+$/.test(portalId)) throw new AppError(400, 'portal_id_invalid', 'Portal identifier is invalid.');
  return `portals/${portalId}/${safePart(category)}/${safePart(id)}/${safePart(filename)}`;
}

export async function createSignedObjectUpload(
  env: Env,
  input: { key: string; contentType: string; contentLength: number; sha256: string; expiresSeconds?: number },
): Promise<string> {
  const { client: storage, bucket } = client(env);
  return getSignedUrl(storage, new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
    Metadata: { sha256: input.sha256 },
  }), { expiresIn: Math.min(MAX_SIGNED_URL_SECONDS, Math.max(60, input.expiresSeconds ?? 600)) });
}

export async function headObject(env: Env, key: string): Promise<{ contentLength: number; contentType: string | null; etag: string | null; sha256: string | null }> {
  const { client: storage, bucket } = client(env);
  try {
    const result = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentLength: Number(result.ContentLength ?? 0),
      contentType: result.ContentType ?? null,
      etag: result.ETag?.replaceAll('"', '') ?? null,
      sha256: result.Metadata?.sha256?.toLowerCase() ?? null,
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) throw new AppError(409, 'object_upload_incomplete', 'The uploaded object is not available yet.');
    throw error;
  }
}

export async function putObject(
  env: Env,
  input: { key: string; body: string | Uint8Array; contentType: string; sha256: string },
): Promise<{ etag: string | null; sizeBytes: number }> {
  const { client: storage, bucket } = client(env);
  const bytes = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
  const result = await storage.send(new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    Body: bytes,
    ContentLength: bytes.byteLength,
    ContentType: input.contentType,
    Metadata: { sha256: input.sha256 },
  }));
  return { etag: result.ETag?.replaceAll('"', '') ?? null, sizeBytes: bytes.byteLength };
}

export async function createSignedObjectDownload(env: Env, key: string, filename?: string, expiresSeconds = 300): Promise<string> {
  const { client: storage, bucket } = client(env);
  return getSignedUrl(storage, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(filename ? { ResponseContentDisposition: `attachment; filename="${safePart(filename)}"` } : {}),
  }), { expiresIn: Math.min(MAX_SIGNED_URL_SECONDS, Math.max(60, expiresSeconds)) });
}

export async function deleteTenantObjects(env: Env, portalId: string): Promise<number> {
  const { client: storage, bucket } = client(env);
  const prefix = `portals/${portalId}/`;
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    const objects = (page.Contents ?? []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []);
    if (objects.length) {
      await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      deleted += objects.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}
