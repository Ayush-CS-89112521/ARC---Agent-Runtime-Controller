import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Context, CancelledFailure } from '@temporalio/activity';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { createBuilderExecutionActivity } from '../../src/temporal/activities/builder-activity';
import { ExecutableRegistry } from '../../src/tools/executable-registry';
import { registerLocalTools } from '../../src/tools/local-adapters';

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  spies.splice(0).forEach(spy => spy.mockRestore());
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root)).toLowerCase()).toBe(resolve(tmpdir()).toLowerCase());
    expect(root.includes('arc-temporal-unit-')).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(permissions: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'arc-temporal-unit-')); roots.push(root);
  const controller = new AbortController();
  const context = { info: { workflowExecution: { workflowId: 'fixture', runId: randomUUID() },
    workflowNamespace: 'unit', activityId: 'execute-builder', attempt: 1 }, cancellationSignal: controller.signal,
    heartbeat: () => {} };
  spies.push(spyOn(Context, 'current').mockReturnValue(context as unknown as Context));
  const activity = createBuilderExecutionActivity({ workspaceRoot: root,
    runtimeFactory: async workspace => ({ registry: registerLocalTools(new ExecutableRegistry(), workspace),
      permissions: new Set(permissions), close: async () => {} }) });
  return { root, activity, context, controller };
}
const prepared = (): any => ({ name: 'fixture', steps: [{ id: 'step_0', name: 'write', prompt: 'fixture',
  tools: [{ id: 'local.write_file', name: 'write' }], input: { path: 'result.txt', content: 'fixture' },
  safety: { timeout: 1000, pattern_scan: true, require_approval: true }, error_handling: { on_failure: 'stop_workflow' } }] });

describe('Temporal activity boundaries without a server', () => {
  it('cannot escalate trusted worker permissions using workflow input', async () => {
    const { activity } = await setup(['files.read']);
    const result = await activity(prepared(), { autoApprove: true, permissionScope: ['files.write'] });
    expect(result.status).toBe('failed');
    expect(result.errors[0]?.message).toContain('Permission denied');
  });
  it('uses stable activity identity and exclusive writes on repeated invocation', async () => {
    const { activity, context } = await setup(['files.write']);
    const first = await activity(prepared(), { autoApprove: true });
    const second = await activity(prepared(), { autoApprove: true });
    expect(first.status).toBe('success'); expect(second.status).toBe('failed');
    expect(first.audit_trail_id).toBe(`fixture/${context.info.workflowExecution.runId}/execute-builder`);
    expect(second.audit_trail_id).toBe(first.audit_trail_id);
  });
  it('rejects absent approval and validates the execution schema', async () => {
    const { activity } = await setup(['files.write']);
    expect((await activity(prepared(), { autoApprove: false })).errors[0]?.message).toContain('Approval required');
    const invalid = prepared(); invalid.steps[0].safety.timeout = -1;
    await expect(activity(invalid, { autoApprove: true })).rejects.toThrow();
  });
  it('isolates workspace directories by run identity', async () => {
    const { root, context } = await setup(['files.write']);
    const workspaces: string[] = [];
    const activity = createBuilderExecutionActivity({ workspaceRoot: root, observe: async event => { workspaces.push(event.workspace); },
      runtimeFactory: async workspace => ({ registry: registerLocalTools(new ExecutableRegistry(), workspace),
        permissions: new Set(['files.write']), close: async () => {} }) });
    await activity(prepared(), { autoApprove: true });
    context.info.workflowExecution.runId = randomUUID();
    await activity(prepared(), { autoApprove: true });
    expect(new Set(workspaces).size).toBe(2);
    for (const workspace of new Set(workspaces)) expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('fixture');
  });
  it('rethrows cancellation after Builder returns an ordinary failed result', async () => {
    const { root, controller } = await setup([]);
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const activity = createBuilderExecutionActivity({ workspaceRoot: root,
      runtimeFactory: async () => ({ permissions: new Set(['fixture.wait']), close: async () => {},
        registry: new ExecutableRegistry().register({ id: 'fixture.wait', name: 'wait', description: 'fixture',
          permission: 'fixture.wait', requiresApproval: false, input: z.object({}).strict(), output: z.string(),
          execute: async (_, invocation) => new Promise<string>((_, reject) => {
            invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true }); started();
          }) }) }) });
    const input = prepared(); input.steps[0].tools = [{ id: 'fixture.wait', name: 'wait' }]; input.steps[0].input = {};
    const result = activity(input, { autoApprove: true });
    await waiting; controller.abort(new CancelledFailure('cancelled fixture'));
    await expect(result).rejects.toBeInstanceOf(CancelledFailure);
  });
});
