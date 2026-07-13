import fs from 'node:fs';

function replaceOnce(content, from, to, file) {
  if (content.includes(to)) return content;
  if (!content.includes(from)) throw new Error(`Expected source block not found in ${file}.`);
  return content.replace(from, to);
}

{
  const file = 'worker/src/repository.ts';
  let content = fs.readFileSync(file, 'utf8');
  content = replaceOnce(
    content,
    "import { DEFAULT_SETTINGS, PLAN_LIMITS } from './config.js';",
    "import { appendAuditChainEvent } from './audit-chain.js';\nimport { DEFAULT_SETTINGS, PLAN_LIMITS } from './config.js';",
    file,
  );
  content = replaceOnce(
    content,
    `  async audit(portalId: string, userId: string | null, userEmail: string | null, action: string, metadata: unknown): Promise<void> {\n    await this.env.DB.prepare(\n      \`INSERT INTO audit_events (id, portal_id, user_id, user_email, action, metadata_json, created_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?)\`\n    ).bind(crypto.randomUUID(), portalId, userId, userEmail, action, JSON.stringify(metadata ?? {}), new Date().toISOString()).run();\n  }`,
    `  async audit(portalId: string, userId: string | null, userEmail: string | null, action: string, metadata: unknown): Promise<void> {\n    const legacyEventId = crypto.randomUUID();\n    const createdAt = new Date().toISOString();\n    await this.env.DB.prepare(\n      \`INSERT INTO audit_events (id, portal_id, user_id, user_email, action, metadata_json, created_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?)\`\n    ).bind(legacyEventId, portalId, userId, userEmail, action, JSON.stringify(metadata ?? {}), createdAt).run();\n    const immutableEventId = await appendAuditChainEvent(this.env, {\n      portalId, action, actorUserId: userId, actorEmail: userEmail, source: 'repository',\n      metadata: { ...(metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : { value: metadata }), legacyEventId, legacyCreatedAt: createdAt },\n    });\n    await this.env.DB.prepare(\`INSERT OR IGNORE INTO legacy_audit_promotions (legacy_event_id, immutable_event_id, promoted_at) VALUES (?, ?, ?)\`)\n      .bind(legacyEventId, immutableEventId, new Date().toISOString()).run();\n  }`,
    file,
  );
  fs.writeFileSync(file, content);
}

{
  const file = 'worker/src/compliance.ts';
  let content = fs.readFileSync(file, 'utf8');
  content = replaceOnce(
    content,
    "import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './crypto.js';",
    "import { appendAuditChainEvent, canonicalAuditValue, type AuditChainInput } from './audit-chain.js';\nimport { decryptSecret, encryptSecret, randomToken, sha256Hex } from './crypto.js';",
    file,
  );
  const start = content.indexOf('export interface ImmutableAuditInput');
  const marker = content.indexOf('export async function verifyAuditChain');
  if (start < 0 || marker < 0 || marker <= start) throw new Error('Compliance audit implementation markers not found.');
  const replacement = `export type ImmutableAuditInput = AuditChainInput;\n\nexport async function appendImmutableAudit(env: Env, input: ImmutableAuditInput): Promise<string> {\n  return appendAuditChainEvent(env, input);\n}\n\n`;
  content = `${content.slice(0, start)}${replacement}${content.slice(marker)}`;
  content = content.replaceAll('stable({', 'canonicalAuditValue({');
  fs.writeFileSync(file, content);
}

console.log('Applied universal immutable-audit integration.');
