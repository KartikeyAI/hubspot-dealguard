import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";
import process from "node:process";

const endpoint = new URL(
  process.env.TIGRIS_ENDPOINT || "https://t3.storage.dev",
);
const region = (process.env.TIGRIS_REGION || "auto").trim();
const bucket = required("TIGRIS_BUCKET");
const accessKeyId = required("TIGRIS_ACCESS_KEY_ID");
const secretAccessKey = required(
  "TIGRIS_SECRET_ACCESS_KEY",
);
const objectKey = String(
  process.env.OBJECT_STORAGE_SMOKE_KEY ||
    `smoke/${Date.now()}-put-check.txt`,
).trim();
const body = Buffer.from(`smoke-check-${Date.now()}`);
const sha256 = createHash("sha256")
  .update(body)
  .digest("hex");
const url = objectUrl(objectKey);
const aws = new AwsClient({
  accessKeyId,
  secretAccessKey,
  service: "s3",
  region,
});

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
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

async function run() {
  const putRequest = await aws.sign(url, {
    method: "PUT",
    headers: {
      "content-type": "text/plain",
      "content-length": String(body.byteLength),
      "x-amz-meta-sha256": sha256,
    },
    body,
  });
  const putResponse = await fetch(putRequest);
  if (!putResponse.ok) {
    throw new Error(
      `Tigris PUT failed with status ${putResponse.status}.`,
    );
  }

  const headRequest = await aws.sign(url, {
    method: "HEAD",
    headers: { accept: "*/*" },
  });
  const headResponse = await fetch(headRequest);
  if (!headResponse.ok) {
    throw new Error(
      `Tigris HEAD failed with status ${headResponse.status}.`,
    );
  }

  const downloadUrl = new URL(url.toString());
  downloadUrl.searchParams.set(
    "response-content-disposition",
    'attachment; filename="download.txt"',
  );
  downloadUrl.searchParams.set("X-Amz-Expires", "300");
  const downloadRequest = await aws.sign(downloadUrl, {
    method: "GET",
    aws: {
      service: "s3",
      region,
      signQuery: true,
      allHeaders: false,
      singleEncode: true,
    },
  });
  const downloadResponse = await fetch(downloadRequest.url);
  if (!downloadResponse.ok) {
    throw new Error(
      `Tigris signed GET failed with status ${downloadResponse.status}.`,
    );
  }

  const downloadText = await downloadResponse.text();
  const summary = {
    bucket,
    key: objectKey,
    endpoint: endpoint.origin,
    put: {
      status: putResponse.status,
      etag:
        putResponse.headers
          .get("etag")
          ?.replaceAll('"', "") ?? null,
      sizeBytes: body.byteLength,
    },
    head: {
      status: headResponse.status,
      contentLength: Number(
        headResponse.headers.get("content-length") ?? 0,
      ),
      contentType:
        headResponse.headers.get("content-type") ?? null,
      etag:
        headResponse.headers
          .get("etag")
          ?.replaceAll('"', "") ?? null,
      sha256:
        headResponse.headers
          .get("x-amz-meta-sha256")
          ?.toLowerCase() ?? null,
    },
    download: {
      status: downloadResponse.status,
      body: downloadText,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
