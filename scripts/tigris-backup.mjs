import { createHash, createHmac } from "node:crypto";
import {
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import process from "node:process";

const [command, ...args] = process.argv.slice(2);
const bucket = required("TIGRIS_BUCKET");
const endpoint = new URL(
  process.env.TIGRIS_ENDPOINT || "https://t3.storage.dev",
);
const region = process.env.TIGRIS_REGION || "auto";
const accessKeyId = required("TIGRIS_ACCESS_KEY_ID");
const secretAccessKey = required(
  "TIGRIS_SECRET_ACCESS_KEY",
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function validKey(value) {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("..") ||
    !/^backups\/[a-z0-9_-]+\/[A-Za-z0-9._/-]+$/.test(value)
  )
    throw new Error("Backup key is invalid.");
  return value;
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function objectUrl(key) {
  const encodedKey = key
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(
    `/${bucket}${encodedKey ? `/${encodedKey}` : ""}`,
    endpoint.origin + "/",
  );
}
function canonicalPath(url) {
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `/${segments.join("/")}` || "/";
}
function canonicalQuery(url) {
  const params = Array.from(url.searchParams.entries())
    .map(([name, value]) => [name, value])
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) ||
        leftValue.localeCompare(rightValue),
    );
  return params
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}
function canonicalHeaders(headers) {
  const entries = Array.from(headers.entries())
    .filter(([name]) => name !== "authorization")
    .map(([name, value]) => [
      name.toLowerCase(),
      value.trim(),
    ]);
  entries.sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const signedHeaders = entries
    .map(([name]) => name)
    .join(";");
  const text = entries
    .map(
      ([name, value]) =>
        `${name}:${value.replace(/\s+/g, " ")}\n`,
    )
    .join("");
  return { text, signedHeaders };
}
function signRequest({ method, url, body, headers }) {
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = digest(body ?? "");
  const requestHeaders = new Headers(headers);
  requestHeaders.set("host", url.host);
  requestHeaders.set("x-amz-date", amzDate);
  requestHeaders.set("x-amz-content-sha256", payloadHash);

  const { text: canonicalHeadersText, signedHeaders } =
    canonicalHeaders(requestHeaders);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    canonicalHeadersText,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const canonicalRequestHash = digest(canonicalRequest);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    canonicalRequestHash,
  ].join("\n");
  const key = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(dateStamp)
    .digest();
  const regionKey = createHmac("sha256", key)
    .update(region)
    .digest();
  const serviceKey = createHmac("sha256", regionKey)
    .update("s3")
    .digest();
  const signingKey = createHmac("sha256", serviceKey)
    .update("aws4_request")
    .digest();
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  requestHeaders.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return requestHeaders;
}

async function fetchWithSignature(
  method,
  url,
  body,
  headers = {},
) {
  const signedHeaders = signRequest({
    method,
    url,
    body,
    headers,
  });
  const response = await fetch(url, {
    method,
    headers: signedHeaders,
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Tigris request failed with status ${response.status}: ${text}`,
    );
  }
  return response;
}

if (command === "upload") {
  const [
    file,
    rawKey,
    output = ".release/backup-reference.json",
  ] = args;
  if (!file)
    throw new Error("Upload requires a file path.");
  const key = validKey(rawKey);
  const body = await readFile(file);
  const sha256 = digest(body);
  const url = objectUrl(key);
  await fetchWithSignature("PUT", url, body, {
    "content-type": "application/octet-stream",
    "content-length": String(body.byteLength),
    "x-amz-meta-sha256": sha256,
    "x-amz-meta-source": "dealguard-neon-pg-dump",
    "x-amz-meta-encryption": "aes-256-cbc-pbkdf2",
  });
  const record = {
    schemaVersion: 1,
    provider: "tigris",
    bucket,
    key,
    sha256,
    sizeBytes: body.byteLength,
    encryption: "aes-256-cbc-pbkdf2",
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    output,
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(record));
} else if (command === "head") {
  const [rawKey, expected] = args;
  const key = validKey(rawKey);
  const url = objectUrl(key);
  const response = await fetchWithSignature(
    "HEAD",
    url,
    undefined,
    { accept: "*/*" },
  );
  const actual =
    response.headers
      .get("x-amz-meta-sha256")
      ?.toLowerCase() ?? "";
  if (
    !actual ||
    (expected && actual !== expected.toLowerCase())
  )
    throw new Error(
      "Backup object checksum metadata is missing or mismatched.",
    );
  console.log(
    JSON.stringify({
      bucket,
      key,
      sha256: actual,
      sizeBytes: Number(
        response.headers.get("content-length") ?? 0,
      ),
      etag:
        response.headers.get("etag")?.replaceAll('"', "") ??
        null,
    }),
  );
} else if (command === "download") {
  const [rawKey, file, expected] = args;
  if (!file)
    throw new Error(
      "Download requires an output file path.",
    );
  const key = validKey(rawKey);
  const url = objectUrl(key);
  const response = await fetchWithSignature(
    "GET",
    url,
    undefined,
    { accept: "*/*" },
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = digest(bytes);
  const metadataChecksum =
    response.headers
      .get("x-amz-meta-sha256")
      ?.toLowerCase() ?? "";
  if (
    !metadataChecksum ||
    metadataChecksum !== actual ||
    (expected && expected.toLowerCase() !== actual)
  )
    throw new Error(
      "Downloaded backup checksum validation failed.",
    );
  await writeFile(file, bytes, { mode: 0o600 });
  const info = await stat(file);
  console.log(
    JSON.stringify({
      bucket,
      key,
      sha256: actual,
      sizeBytes: info.size,
    }),
  );
} else {
  throw new Error(
    "Usage: tigris-backup.mjs upload <file> <key> [record] | head <key> [sha256] | download <key> <file> [sha256]",
  );
}
