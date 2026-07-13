import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../dist/crypto.js';

const key = Buffer.alloc(32, 7).toString('base64');

test('encrypts and decrypts OAuth secrets with unique IVs', async () => {
  const first = await encryptSecret('refresh-token', key);
  const second = await encryptSecret('refresh-token', key);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.cipher, second.cipher);
  assert.equal(await decryptSecret(first.cipher, first.iv, key), 'refresh-token');
});

test('generates URL-safe random state and stable SHA-256 digest', async () => {
  const state = randomToken();
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.equal((await sha256Hex('dealguard')).length, 64);
});

test('rejects encryption keys with the wrong size', async () => {
  await assert.rejects(() => encryptSecret('secret', Buffer.alloc(16).toString('base64')), /32 bytes/);
});
