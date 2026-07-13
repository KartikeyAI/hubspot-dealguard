import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AcceptanceClient, bool, sanitize, safeUrl } from '../scripts/acceptance-core.mjs';

const config = {
  baseUrl: 'https://dealguard-api.rokad.co',
  portalId: '12345',
  appId: '67890',
  userId: '42',
  userEmail: 'operator@example.com',
  clientSecret: 'hubspot-test-secret',
  dodoWebhookSecret: `whsec_${Buffer.from('dodo-test-secret').toString('base64url')}`,
  timeoutMs: 1000,
};

test('acceptance booleans and evidence redaction are deterministic', () => {
  assert.equal(bool('true'), true);
  assert.equal(bool('0', true), false);
  assert.equal(safeUrl('https://example.com/path?secret=value'), 'https://example.com/path');
  assert.deepEqual(sanitize({ accessToken: 'secret', userEmail: 'operator@example.com', checkoutUrl: 'https://example.com/checkout?token=abc' }), {
    accessToken: '[REDACTED]',
    userEmail: 'o***@example.com',
    checkoutUrl: 'https://example.com/checkout',
  });
});

test('acceptance client produces HubSpot v3 signatures for the exact decoded URL and body', () => {
  const client = new AcceptanceClient(config);
  const url = client.identityUrl('/api/v1/billing?view=summary');
  const body = JSON.stringify({ tier: 'enterprise' });
  const headers = client.hubSpotHeaders('POST', url, body);
  const timestamp = headers['x-hubspot-request-timestamp'];
  const decodedUrl = url.toString().replaceAll('%40', '@').replaceAll('%40'.toLowerCase(), '@');
  const source = `POST${decodedUrl}${body}${timestamp}`;
  const expected = createHmac('sha256', config.clientSecret).update(source).digest('base64');
  assert.equal(headers['x-hubspot-signature-v3'], expected);
  assert.equal(url.searchParams.get('portalId'), '12345');
  assert.equal(url.searchParams.get('appId'), '67890');
  assert.equal(url.searchParams.get('userEmail'), 'operator@example.com');
});

test('acceptance client produces Dodo Standard Webhook signatures', () => {
  const client = new AcceptanceClient(config);
  const body = JSON.stringify({ type: 'payment.failed', timestamp: '2026-07-13T00:00:00.000Z' });
  const headers = client.dodoHeaders(body, true);
  const signature = headers['webhook-signature'].split(',', 2)[1];
  const expected = createHmac('sha256', Buffer.from('dodo-test-secret'))
    .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`)
    .digest('base64url');
  assert.equal(signature, expected);
});
