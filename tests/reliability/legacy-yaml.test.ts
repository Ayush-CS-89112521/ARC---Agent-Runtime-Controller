import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowFromYaml } from '../../src/parsers/workflow-parser';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const header = 'version: "1"\nname: compatibility\nconfig: { timeout: 5000, retries: 0 }\nsteps:\n';

async function run(steps: string, options: { cancel?: boolean; safety?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'arc-yaml-'));
  try {
    await writeFile(join(cwd, 'workflow.yaml'), header.replace('retries: 0', options.safety ? 'retries: 0, safety: { mode: block }' : 'retries: 0') + steps);
    const child = Bun.spawn([process.execPath, fixture('run-yaml-workflow.ts'), fixture('fake-copilot.mjs'), ...(options.cancel ? ['cancel'] : [])], {
      cwd, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`YAML fixture exited ${code}: ${stderr}\n${stdout}`);
    const report = JSON.parse(stdout.split('FIXTURE_REPORT=')[1]!);
    const file = join(cwd, 'workflow-executions', report.context.runId, 'outputs', 'nested', 'answer.txt');
    const output = await readFile(file, 'utf8').catch(() => '');
    const pid = await readFile(join(cwd, 'fixture.pid'), 'utf8').catch(() => '');
    if (pid) expect(() => process.kill(Number(pid), 0)).toThrow();
    return { report, output, pid };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('legacy YAML routes explicit tiers and resolves JSON output before a dependent file step', async () => {
  const { report, output } = await run(`
  - id: first
    agent: suggest
    model: sonnet
    prompt: produce fixture JSON
    output: {type: variable, name: answer}
  - id: second
    agent: explain
    model: haiku
    prompt: 'text-response missing-usage explain \${steps.first.output.value}'
    output: {type: file, path: nested/answer.txt}
`);
  expect(report.success).toBe(true);
  const [first, second] = report.context.results;
  const args = first.parsedOutput.args;
  expect(args.slice(0, -1)).toEqual([
    'copilot', '--', '-s', '-p', 'Workflow task mode: suggest. Return the result as text.\n\nproduce fixture JSON',
    '--available-tools=', '--disable-builtin-mcps', '--deny-tool=shell', '--deny-tool=write',
    '--deny-tool=read', '--deny-tool=memory', '--deny-tool=url', '--no-custom-instructions',
    '--no-ask-user', '--no-auto-update', '--sync-session=off', '--log-level=error',
    '--model', 'claude-sonnet-4.5', '--usage-output-file',
  ]);
  expect(first.requestedModelTier).toBe('sonnet');
  expect(first.reportedModels).toEqual(['fixture-provider-model']);
  expect(first.copilotUsage).toEqual({ totalPremiumRequestCost: 1, totalNanoAiu: 123 });
  expect(second.requestedModelTier).toBe('haiku');
  expect(second.reportedModels).toEqual([]);
  expect(second.copilotUsage).toBeUndefined();
  expect(second.parsedOutput).toBe('plain fixture response');
  expect(output).toContain('plain fixture response');
}, 15000);

test('legacy YAML selects a default per task and propagates subprocess rejection without model fallback', async () => {
  const result = await Promise.all(['suggest', 'edit'].map(agent => run(`
  - id: routed
    agent: ${agent}
    prompt: show arguments
    output: {type: variable, name: answer}
  - id: refused
    agent: suggest
    prompt: reject-model
    output: {type: variable, name: result}
`)));
  expect(result.map(item => item.report.context.results[0].requestedModelTier)).toEqual(['haiku', 'sonnet']);
  for (const [index, item] of result.entries()) {
    expect(item.report.success).toBe(false);
    const [routed, refused] = item.report.context.results;
    expect(routed.parsedOutput.args.slice(-4, -1)).toEqual(['--model', ['claude-haiku-4.5', 'claude-sonnet-4.5'][index], '--usage-output-file']);
    expect(refused.error).toContain('exited with code 23');
    expect(refused.retriesAttempted).toBe(0);
  }
}, 15000);

test('legacy YAML timeout waits for subprocess termination', async () => {
  const { report, pid } = await run(`
  - id: slow
    agent: suggest
    timeout: 2000
    prompt: hold-child
    output: {type: variable, name: answer}
`);
  expect(pid).toMatch(/^\d+$/);
  expect(report.success).toBe(false);
  expect(report.context.results[0].error).toContain('timed out');
}, 15000);

test('YAML rejects unknown model tiers', () => {
  expect(() => parseWorkflowFromYaml(header + `
  - id: invalid
    agent: suggest
    model: opus
    prompt: example
    output: {type: variable, name: result}
`, 'fixture.yaml')).toThrow('steps.0.model');
});

test('long suggest tasks request the higher tier and still preserve the provider identity', async () => {
  const { report } = await run(`
  - id: long
    agent: suggest
    prompt: ${'a'.repeat(12001)}
    output: {type: variable, name: result}
`);
  const [result] = report.context.results;
  expect(report.success).toBe(true);
  expect(result.requestedModelTier).toBe('sonnet');
  expect(result.parsedOutput.args.slice(-4, -1)).toEqual(['--model', 'claude-sonnet-4.5', '--usage-output-file']);
  expect(result.reportedModels).toEqual(['fixture-provider-model']);
}, 15000);

test('YAML rejects duplicate step IDs and does not report success for escaping file outputs', async () => {
  const repeated = `
  - id: duplicate
    agent: suggest
    prompt: example
    output: {type: variable, name: result}
`;
  expect(() => parseWorkflowFromYaml(header + repeated + repeated, 'fixture.yaml')).toThrow('Duplicate step IDs');
  const { report } = await run(`
  - id: escape
    agent: suggest
    prompt: example
    output: {type: file, path: ../outside.txt}
`);
  expect(report.success).toBe(false);
  expect(report.context.results[0].error).toContain('inside the run output directory');
}, 15000);

test('a rejected YAML response never writes an output artifact', async () => {
  for (const prompt of ['blocked-output', 'malformed-json']) {
    const { report, output } = await run(`
  - id: rejected
    agent: suggest
    prompt: ${prompt}
    output: {type: file, path: nested/answer.txt}
`, { safety: true });
    expect(report.success).toBe(false);
    expect(report.context.results[0].success).toBe(false);
    expect(output).toBe('');
  }
}, 15000);

test('external YAML cancellation waits for the fake CLI to terminate', async () => {
  const { report, pid } = await run(`
  - id: cancel
    agent: suggest
    prompt: hold-child
    output: {type: variable, name: result}
`, { cancel: true });
  expect(pid).toMatch(/^\d+$/);
  expect(report.success).toBe(false);
  expect(report.context.results[0].error).toContain('fixture cancelled');
}, 15000);

test('YAML artifact writes cannot follow an output-directory junction outside the run', async () => {
  const { saveStepOutputToFilesystem } = await import('../../src/execution/step-executor');
  const { getRunDirectory, initializeContext } = await import('../../src/context/context-manager');
  const workflow = parseWorkflowFromYaml(header + `
  - id: junction
    agent: suggest
    prompt: example
    output: {type: file, path: redirect/nested/answer.txt}
`, 'fixture.yaml');
  const context = initializeContext(workflow);
  const run = getRunDirectory(context.runId);
  const outside = await mkdtemp(join(tmpdir(), 'arc-output-target-'));
  try {
    await mkdir(join(run, 'outputs'), { recursive: true });
    await symlink(outside, join(run, 'outputs', 'redirect'), 'junction');
    await expect(saveStepOutputToFilesystem(context, workflow.steps[0]!, 'fixture')).rejects.toThrow('symbolic link');
    await expect(readFile(join(outside, 'nested', 'answer.txt'))).rejects.toThrow();
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
