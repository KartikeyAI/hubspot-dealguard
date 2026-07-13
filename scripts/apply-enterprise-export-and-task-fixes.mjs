import fs from 'node:fs';

function replaceOnce(content, from, to, file) {
  if (content.includes(to)) return content;
  if (!content.includes(from)) throw new Error(`Expected source block not found in ${file}: ${from.slice(0, 120)}`);
  return content.replace(from, to);
}

{
  const file = 'worker/src/remediation-enterprise.ts';
  let content = fs.readFileSync(file, 'utf8');
  content = replaceOnce(
    content,
    "import { createRemediationCase, transitionRemediationCase, type RemediationCase } from './remediation.js';",
    "import { transitionRemediationCase, type RemediationCase } from './remediation.js';\nimport { attachTaskToExistingRemediation } from './remediation-task.js';",
    file,
  );
  content = replaceOnce(
    content,
    `      } else if (operation === 'create_tasks') {\n        const detail = await remediationDetail(env, identity, caseId);\n        const item = detail.case as Record<string, unknown>;\n        if (item.hubSpotTaskId) { succeeded += 1; continue; }\n        const created = await createRemediationCase(env, identity, {\n          dealId: item.dealId, issueCode: \`${'${item.issueCode}'}.task\`, title: item.title, description: item.description,\n          severity: item.severity, priority: item.priority, ownerId: item.ownerId, ownerEmail: item.ownerEmail,\n          dueAt: item.dueAt, createHubSpotTask: true,\n        }, 'manual');\n        if (!created.hubSpotTaskId) throw new AppError(502, 'hubspot_task_not_created', 'HubSpot task creation failed.');\n      }`,
    `      } else if (operation === 'create_tasks') {\n        await attachTaskToExistingRemediation(env, identity, caseId);\n      }`,
    file,
  );
  fs.writeFileSync(file, content);
}

{
  const file = 'src/app/pages/EnterpriseHomeV2.tsx';
  let content = fs.readFileSync(file, 'utf8');
  content = replaceOnce(
    content,
    "  const [portalUrl, setPortalUrl] = useState<string | null>(null);",
    "  const [portalUrl, setPortalUrl] = useState<string | null>(null);\n  const [secureExportUrl, setSecureExportUrl] = useState<string | null>(null);",
    file,
  );
  content = replaceOnce(
    content,
    `  const loadPolicyDetail = async () => {`,
    `  const prepareSecureDownload = async (kind: 'policy' | 'analytics' | 'audit' | 'data_export', options: { resourceId?: string; format?: string; params?: Json } = {}) => {\n    await act(async () => {\n      const result = await request('/enterprise/downloads', { method: 'POST', body: { kind, ...options } });\n      setSecureExportUrl(result.url);\n    }, 'A one-time secure download is ready for ten minutes.');\n  };\n\n  const loadPolicyDetail = async () => {`,
    file,
  );
  content = replaceOnce(
    content,
    `<Flex direction="row" gap="small" wrap="wrap"><Button onClick={() => void loadPolicyDetail()} disabled={!selectedPolicy || working}>Load segments and diff</Button><Link href={{ url: \`${'${API_BASE}'}/governance/policies/${'${selectedPolicy}'}/export\`, external: true }}>Export policy package</Link></Flex>`,
    `<Flex direction="row" gap="small" wrap="wrap"><Button onClick={() => void loadPolicyDetail()} disabled={!selectedPolicy || working}>Load segments and diff</Button><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.export')} onClick={() => void prepareSecureDownload('policy', { resourceId: selectedPolicy })}>Prepare secure policy export</Button></Flex>`,
    file,
  );
  content = replaceOnce(
    content,
    `<Link href={{ url: \`${'${API_BASE}'}/enterprise/analytics/export?days=${'${analyticsDays}'}&audience=${'${analyticsAudience}'}\`, external: true }}>Export pipeline analytics CSV</Link>`,
    `<Button variant="secondary" disabled={working || !can('analytics.export')} onClick={() => void prepareSecureDownload('analytics', { format: 'csv', params: { days: analyticsDays, audience: analyticsAudience } })}>Prepare secure analytics CSV</Button>`,
    file,
  );
  content = replaceOnce(
    content,
    `<Flex direction="row" gap="small" wrap="wrap"><Link href={{url:\`${'${API_BASE}'}/enterprise/compliance/audit/export?format=csv\`,external:true}}>CSV</Link><Link href={{url:\`${'${API_BASE}'}/enterprise/compliance/audit/export?format=json\`,external:true}}>JSON</Link><Link href={{url:\`${'${API_BASE}'}/enterprise/compliance/audit/export?format=jsonl\`,external:true}}>JSONL</Link></Flex>`,
    `<Flex direction="row" gap="small" wrap="wrap"><Button variant="secondary" disabled={working || !can('audit.export')} onClick={() => void prepareSecureDownload('audit', { format: 'csv' })}>Prepare CSV</Button><Button variant="secondary" disabled={working || !can('audit.export')} onClick={() => void prepareSecureDownload('audit', { format: 'json' })}>Prepare JSON</Button><Button variant="secondary" disabled={working || !can('audit.export')} onClick={() => void prepareSecureDownload('audit', { format: 'jsonl' })}>Prepare JSONL</Button></Flex>`,
    file,
  );
  content = replaceOnce(
    content,
    `const result=await request('/enterprise/compliance/exports',{method:'POST',body:{scope:exportScope,format:exportFormat}}); setDownloadPath(result.downloadPath);`,
    `const result=await request('/enterprise/compliance/exports',{method:'POST',body:{scope:exportScope,format:exportFormat}}); const secure=await request('/enterprise/downloads',{method:'POST',body:{kind:'data_export',resourceId:result.id,format:exportFormat}}); setSecureExportUrl(secure.url); setDownloadPath(null);`,
    file,
  );
  content = replaceOnce(
    content,
    `{downloadPath&&<Link href={{url:\`https://dealguard-api.rokad.co${'${downloadPath}'}\`,external:true}}>Download prepared export</Link>}`,
    `{downloadPath&&<Text>Legacy download path prepared: {downloadPath}</Text>}`,
    file,
  );
  content = replaceOnce(
    content,
    `{error&&<Alert title="Action failed" variant="danger">{error}</Alert>}{notice&&<Alert title="DealGuard Enterprise" variant="success">{notice}</Alert>}`,
    `{error&&<Alert title="Action failed" variant="danger">{error}</Alert>}{notice&&<Alert title="DealGuard Enterprise" variant="success">{notice}</Alert>}{secureExportUrl&&<Alert title="Secure export ready" variant="success"><Link href={{url:secureExportUrl,external:true}}>Download once — expires in ten minutes</Link></Alert>}`,
    file,
  );
  fs.writeFileSync(file, content);
}

console.log('Applied secure-export UI and existing-case task fixes.');
