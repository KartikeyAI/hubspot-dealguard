import { AppError } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64Key);
  } catch {
    throw new AppError(500, 'invalid_encryption_key', 'TOKEN_ENCRYPTION_KEY must be base64 encoded.');
  }
  if (bytes.byteLength !== 32) {
    throw new AppError(500, 'invalid_encryption_key', 'TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', asArrayBuffer(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value: string, base64Key: string): Promise<{ cipher: string; iv: string }> {
  const key = await importEncryptionKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asArrayBuffer(iv) }, key, asArrayBuffer(encoder.encode(value)));
  return { cipher: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(cipher: string, iv: string, base64Key: string): Promise<string> {
  try {
    const key = await importEncryptionKey(base64Key);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asArrayBuffer(base64ToBytes(iv)) },
      key,
      asArrayBuffer(base64ToBytes(cipher)),
    );
    return decoder.decode(decrypted);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'token_decryption_failed', 'Stored HubSpot credentials could not be decrypted.');
  }
}

export function randomToken(bytes = 32): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
