import { AppError } from './errors.js';

/** Bound raw bytes while reading, including chunked bodies without Content-Length. */
export async function readBoundedText(request: Pick<Request, 'headers' | 'body' | 'signal'>, maximumBytes: number, timeoutMs = 10_000): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error('Invalid request-body limit');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new AppError(400, 'invalid_content_length', 'The request content length is invalid.');
  }
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: AppError) => void = () => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => reject(new AppError(408, 'request_body_timeout', 'The request body did not arrive within the allowed time.')), timeoutMs);
  });
  const cancelled = () => rejectAbort(new AppError(408, 'request_body_cancelled', 'The request was cancelled.'));
  request.signal.addEventListener('abort', cancelled, { once: true });
  if (request.signal.aborted) cancelled();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abort]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) throw new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new AppError(400, 'invalid_body_encoding', 'Request bodies must use valid UTF-8.'); }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancelled);
    // Cancelling one tee branch can wait for its peer. Never await it here.
    void reader.cancel().catch(() => undefined);
  }
}
