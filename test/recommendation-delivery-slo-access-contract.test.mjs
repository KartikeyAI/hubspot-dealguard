import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../worker/src/enterprise-access.ts', import.meta.url), 'utf8');

function roleSection(role, nextRole) {
  const tail = nextRole ? `\\n\\s*\\],\\n\\s*${nextRole}:` : `\\n\\s*\\],`;
  return source.match(new RegExp(`${role}:\\s*\\[([\\s\\S]*?)${tail}`))?.[1] ?? '';
}

test('RevOps managers can view and manage portal-wide reliability controls', () => {
  const section = roleSection('revops_manager', 'sales_manager');
  assert.match(section, /'reliability\.view'/);
  assert.match(section, /'reliability\.manage'/);
  assert.match(section, /'alert\.manage'/);
});

test('policy, remediation and compliance roles can inspect reliability evidence', () => {
  const roles = [
    ['policy_administrator', 'revops_manager'],
    ['remediation_manager', 'compliance_auditor'],
    ['compliance_auditor', 'billing_administrator'],
  ];
  for (const [role, nextRole] of roles) {
    assert.match(roleSection(role, nextRole), /'reliability\.view'/, `${role} must include reliability.view`);
  }
});

test('general sales, review, billing and viewer roles do not receive portal-wide reliability evidence by default', () => {
  const roles = [
    ['sales_manager', 'reviewer'],
    ['reviewer', 'remediation_manager'],
    ['billing_administrator', 'viewer'],
    ['viewer', null],
  ];
  for (const [role, nextRole] of roles) {
    const section = roleSection(role, nextRole);
    assert.doesNotMatch(section, /'reliability\.view'/, `${role} must not include reliability.view`);
    assert.doesNotMatch(section, /'reliability\.manage'/, `${role} must not include reliability.manage`);
  }
});

test('delivery SLO mutation remains limited to RevOps managers and wildcard administrators', () => {
  for (const [role, nextRole] of [
    ['policy_administrator', 'revops_manager'],
    ['sales_manager', 'reviewer'],
    ['reviewer', 'remediation_manager'],
    ['remediation_manager', 'compliance_auditor'],
    ['compliance_auditor', 'billing_administrator'],
    ['billing_administrator', 'viewer'],
    ['viewer', null],
  ]) {
    assert.doesNotMatch(roleSection(role, nextRole), /'reliability\.manage'/, `${role} must not include reliability.manage`);
  }
  assert.match(source, /administrator: \['\*'\]/);
});
