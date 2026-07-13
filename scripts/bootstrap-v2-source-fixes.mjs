import fs from 'node:fs';
import path from 'node:path';

const replacements = new Map([
  ['worker/src/alerting-enterprise.ts', [
    ["typeof item === 'string' && item.trim()", "typeof item === 'string' && Boolean(item.trim())"],
  ]],
  ['worker/src/enterprise-access.ts', [
    ["typeof item === 'string' && item.trim()", "typeof item === 'string' && Boolean(item.trim())"],
  ]],
  ['worker/src/enterprise-policy.ts', [
    ["typeof item === 'string' && item.trim()", "typeof item === 'string' && Boolean(item.trim())"],
    ["rules: found.rules as RuleSettings", "rules: found.rules as unknown as RuleSettings"],
  ]],
  ['worker/src/billing.ts', [
    ["'billing.checkout_created', { provider: 'dodo', tier, interval, ...metadata }", "'billing.checkout_created', { provider: 'dodo', ...metadata }"],
    ["crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])", "crypto.subtle.importKey('raw', Uint8Array.from(secret).buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])"],
  ]],
  ['worker/src/enterprise-routes.ts', [
    ["payload: body.payload,\n        expiresAt: body.expiresAt,", "payload: body.payload,\n        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),"],
  ]],
  ['worker/src/routes-v2.ts', [
    ["contractReference: body.contractReference,\n        purchaseOrderReference: body.purchaseOrderReference,\n        currency: body.currency,\n        usageMode: body.usageMode,\n        overageEnabled: body.overageEnabled,", "...(body.contractReference !== undefined ? { contractReference: body.contractReference } : {}),\n        ...(body.purchaseOrderReference !== undefined ? { purchaseOrderReference: body.purchaseOrderReference } : {}),\n        ...(body.currency !== undefined ? { currency: body.currency } : {}),\n        ...(body.usageMode !== undefined ? { usageMode: body.usageMode } : {}),\n        ...(body.overageEnabled !== undefined ? { overageEnabled: body.overageEnabled } : {}),"],
    ["{ usageMode: body.usageMode, overageEnabled: body.overageEnabled },", "{\n        ...(body.usageMode !== undefined ? { usageMode: body.usageMode } : {}),\n        ...(body.overageEnabled !== undefined ? { overageEnabled: body.overageEnabled } : {}),\n      },"],
  ]],
]);

let changed = false;
for (const [file, rules] of replacements) {
  const absolute = path.resolve(file);
  let content = fs.readFileSync(absolute, 'utf8');
  for (const [from, to] of rules) {
    if (content.includes(from)) {
      content = content.replace(from, to);
      changed = true;
    } else if (!content.includes(to)) {
      throw new Error(`Expected source pattern was not found in ${file}: ${from}`);
    }
  }
  fs.writeFileSync(absolute, content);
}

const legacyRouter = path.resolve('worker/src/routes.ts');
if (fs.existsSync(legacyRouter)) {
  fs.unlinkSync(legacyRouter);
  changed = true;
}

console.log(changed ? 'Applied v2 source corrections.' : 'V2 source corrections were already applied.');
