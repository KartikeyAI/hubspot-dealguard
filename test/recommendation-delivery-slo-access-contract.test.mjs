import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../worker/src/enterprise-access.ts', import.meta.url), 'utf8');

test('RevOps managers can view and manage portal-wide reliability controls', () => {
  const section = source.match(/revops_manager:\s*\[([\s\S]*?)\n\s*\],\n\s*sales_manager:/)?.[1] ?? '';
  assert.match(section, /'reliability\.view'/);
  assert.match(section, /'reliability\.manage'/);
  assert.match(section, /'alert\.manage'/);
});

test('operating, audit and read-only roles can inspect reliability evidence', () => {
  for (const role of [
    'policy_administrator',
    'sales_manager',
    'reviewer',
    'remediation_manager',
    'compliance_auditor',
    'viewer',
  ]) {
    const pattern = new RegExp(`${role}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`);
    const section = source.match(pattern)?.[1] ?? '';
    assert.match(section, /'reliability\.view'/, `${role} must include reliability.view`);
  }
});

test('delivery SLO mutation remains limited to RevOps managers and wildcard administrators', () => {
  for (const role of ['sales_manager', 'reviewer', 'remediation_manager', 'compliance_auditor', 'viewer']) {
    const pattern = new RegExp(`${role}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`);
    const section = source.match(pattern)?.[1] ?? '';
    assert.doesNotMatch(section, /'reliability\.manage'/, `${role} must not include reliability.manage`);
  }
  assert.match(source, /administrator: \['\*'\]/);
});
