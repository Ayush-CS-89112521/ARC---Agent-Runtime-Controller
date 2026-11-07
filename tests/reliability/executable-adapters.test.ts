import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ExecutableRegistry, type Invocation } from '../../src/tools/executable-registry';
import { registerLocalTools } from '../../src/tools/local-adapters';
import { connectMcpServer } from '../../src/tools/mcp-adapter';
import { BuilderAgent } from '../../src/agents/builder';
import { PlanConverter } from '../../src/parsers/plan-converter';
import { convertBuilderResultToReport, initializeBridgeContext } from '../../src/engine/orchestration-bridge';
import { ArchitectAgent } from '../../src/agents/architect';
import { ArchitectService } from '../../src/services/architect-service';
import { AutoSwitchOrchestrator } from '../../src/engine/auto-switch-orchestrator';

const invocation = (extra: Partial<Invocation> = {}): Invocation => ({
  permissions: new Set(['files.read', 'files.write', 'fixture']), approved: true,
  signal: new AbortController().signal, timeoutMs: 1000, ...extra,
});
const makeStep = (id: string, input: unknown, tool = 'fixture'): any => ({ id, name: id, input, prompt: 'fixture',
  tools: [{ id: tool, name: tool }], safety: { timeout: 500 }, error_handling: { on_failure: 'stop_workflow' } });

describe('Executable adapters and controller', () => {
  it('queues a future skip without cancelling the currently active tool', async () => {
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    let aborted = false;
    const registry = new ExecutableRegistry().register({ id: 'fixture', name: 'fixture', description: 'fixture',
      permission: 'fixture', requiresApproval: false, input: z.object({}).strict(), output: z.string(),
      execute: async (_, context) => { calls++; context.signal.addEventListener('abort', () => { aborted = true; }); ready(); await held; return 'ok'; },
    });
    const builder = new BuilderAgent(registry);
    const completed = builder.execute({ name: 'queued skip', steps: [makeStep('step_0', {}), makeStep('step_1', {})] } as any,
      { permissions: new Set(['fixture']), executionId: 'queued' });
    await started;
    await builder.handleSteeringInput('step_1', { action: 'skip' }, 'queued');
    release();
    const result = await completed;
    expect(aborted).toBe(false);
    expect(calls).toBe(1);
    expect(result.step_results[1].status).toBe('skipped');
  });
  it('runs controlled Copilot JSON through real planning, approval, adapter IO and reporting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arc-planner-e2e-'));
    try {
      const registry = registerLocalTools(new ExecutableRegistry(), dir);
      const response = { steps: [{ step_id: 1, step_name: 'Create file', tool_needed: 'local.write_file',
        reasoning: 'fixture', expected_output: 'file created', dependencies: [], input: { path: 'planned.txt', content: 'planned output' } }],
        confidence_score: 1, execution_order: [1] };
      let requested = false;
      const agent = new ArchitectAgent({}, async prompt => { requested = prompt.includes('local.write_file'); return JSON.stringify(response); });
      const orchestrator: any = new AutoSwitchOrchestrator({ autoApprove: true, permissions: ['files.write'] }, registry);
      orchestrator.architectService = new ArchitectService({}, registry.catalog(), agent);
      const completed = await orchestrator.executeFullPipeline('Create a workspace file');
      const report = convertBuilderResultToReport({ name: 'planned', steps: completed.steps } as any,
        completed.result, initializeBridgeContext({ name: 'planned', steps: completed.steps } as any, {}));
      expect(requested).toBe(true);
      expect(completed.decision.approved).toBe(true);
      expect(report.success).toBe(true);
      expect(await readFile(join(dir, 'planned.txt'), 'utf8')).toBe('planned output');
      expect(report.context.results).toHaveLength(1);
      const badAgent = new ArchitectAgent({}, async () => '{malformed fixture');
      const failure = await badAgent.plan('fixture', { pruned_tools: [{ id: 'fixture', name: 'fixture', category: 'test' }], pruned_count: 1 } as any);
      expect('error_code' in failure).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('enforces timeout at the adapter and prevents future scheduling', async () => {
    let aborted = false;
    let calls = 0;
    const registry = new ExecutableRegistry().register({ id: 'fixture', name: 'fixture', description: 'fixture',
      input: z.object({}).strict(), output: z.string(), permission: 'fixture', requiresApproval: false,
      execute: async (_, context) => new Promise<string>((_, reject) => {
        calls++;
        context.signal.addEventListener('abort', () => { aborted = true; reject(context.signal.reason); }, { once: true });
      }),
    });
    const first = makeStep('step_0', {}); first.safety.timeout = 15; first.error_handling.on_failure = 'skip_step';
    const result = await new BuilderAgent(registry).execute({ name: 'timeout', steps: [first, makeStep('step_1', {})] } as any,
      { permissions: new Set(['fixture']) });
    expect(result.status).toBe('failed');
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
  });

  it('applies pre-execution steering and isolates per-execution audit snapshots', async () => {
    const prompts: string[] = [];
    const builder = new BuilderAgent(new Map([['fixture', { id: 'fixture', name: 'fixture', execute: async (prompt: string) => { prompts.push(prompt); return 'ok'; } }]]));
    await builder.handleSteeringInput('step_0', { action: 'modify', modified_prompt: 'changed fixture' });
    const first = await builder.execute({ name: 'first', steps: [makeStep('step_0', {})] } as any, { executionId: 'first', permissions: new Set(['tool:fixture']) });
    await builder.execute({ name: 'second', steps: [makeStep('step_0', {})] } as any, { executionId: 'second', permissions: new Set(['tool:fixture']) });
    expect(prompts).toEqual(['changed fixture', 'fixture']);
    expect(first.audit_trail_id).toBe('first');
    const snapshot = builder.getAuditTrail('first');
    expect(snapshot.some(event => event.event_type === 'step_completed')).toBe(true);
    snapshot.length = 0;
    expect(builder.getAuditTrail('first').length).toBeGreaterThan(0);
  });
  it('executes actual local file operations only after validation, grants, and approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arc-adapter-'));
    const registry = registerLocalTools(new ExecutableRegistry(), dir);
    const input = { path: 'result.txt', content: 'verified fixture' };
    try {
      await expect(registry.invoke('unknown', {}, invocation())).rejects.toThrow('not registered');
      await expect(registry.invoke('local.write_file', input, invocation({ permissions: new Set() }))).rejects.toThrow('Permission');
      await expect(registry.invoke('local.write_file', input, invocation({ approved: false }))).rejects.toThrow('Approval');
      await expect(registry.invoke('local.write_file', { ...input, unexpected: true }, invocation())).rejects.toThrow();
      await expect(registry.invoke('local.write_file', { ...input, path: '../escape.txt' }, invocation())).rejects.toThrow('escapes');
      await registry.invoke('local.write_file', input, invocation());
      expect(await readFile(join(dir, 'result.txt'), 'utf8')).toBe('verified fixture');
      expect(await registry.invoke('local.read_file', { path: 'result.txt' }, invocation())).toEqual({ content: 'verified fixture' });
      await expect(registry.invoke('local.write_file', input, invocation())).rejects.toThrow();
      const grants = new Set(['files.read']);
      grants.clear();
      await expect(registry.invoke('local.read_file', { path: 'result.txt' }, invocation({ permissions: grants }))).rejects.toThrow('Permission');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('converts a plan and runs real adapters through Builder, state, and final report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arc-e2e-'));
    try {
      const registry = registerLocalTools(new ExecutableRegistry(), dir);
      const conversion = await new PlanConverter(registry.catalog()).convert({ request_summary: 'isolated write/read',
        steps: [{ step_id: 10, step_name: 'write', tool_needed: 'local.write_file', reasoning: 'fixture', input: { path: 'out.txt', content: 'real output' } },
          { step_id: 20, step_name: 'read', tool_needed: 'local.read_file', reasoning: 'fixture', dependencies: [10], input: { path: 'out.txt' } }],
      } as any);
      const builder = new BuilderAgent(registry);
      const denied = await builder.execute(conversion.workflow, { permissions: invocation().permissions, approved: false });
      expect(denied.status).toBe('failed');
      const result = await builder.execute(conversion.workflow, { permissions: invocation().permissions, approved: true });
      const report = convertBuilderResultToReport(conversion.workflow, result, initializeBridgeContext(conversion.workflow, {}));
      expect(report.success).toBe(true);
      expect(report.context.results[1].output).toContain('real output');
      expect(report.stats.successfulSteps).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed adapter output and duplicate registrations', async () => {
    const tool = { id: 'fixture', name: 'fixture', description: 'fixture', permission: 'fixture', requiresApproval: false,
      input: z.object({}).strict(), output: z.string(), execute: async () => 42 };
    const registry = new ExecutableRegistry().register(tool);
    expect(() => registry.register(tool)).toThrow('Duplicate');
    await expect(registry.invoke('fixture', {}, invocation())).rejects.toThrow();
  });

  it('propagates controller cancellation and active steering to the underlying tool', async () => {
    for (const action of ['signal', 'terminate', 'skip'] as const) {
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      let aborted = false;
      const registry = new ExecutableRegistry().register({ id: 'fixture', name: 'fixture', description: 'fixture',
        permission: 'fixture', requiresApproval: false, input: z.object({}).strict(), output: z.string(),
        execute: async (_, context) => new Promise<string>((_, reject) => {
          context.signal.addEventListener('abort', () => { aborted = true; reject(context.signal.reason); }, { once: true }); ready();
        }),
      });
      const builder = new BuilderAgent(registry);
      const controller = new AbortController();
      const result = builder.execute({ name: 'steering', steps: [makeStep('step_0', {}), makeStep('step_1', {})] } as any,
        { permissions: invocation().permissions, signal: controller.signal, executionId: action });
      await started;
      if (action === 'signal') controller.abort(new Error('fixture cancellation'));
      else await builder.handleSteeringInput('step_0', { action }, action);
      const completed = await result;
      expect(aborted).toBe(true);
      if (action === 'skip') expect(completed.step_results[0].status).toBe('skipped');
      else { expect(completed.status).toBe('failed'); expect(completed.step_results).toHaveLength(1); }
    }
  });

  it('talks to an actual isolated MCP stdio server with schema and cancellation checks', async () => {
    const registry = new ExecutableRegistry();
    const close = await connectMcpServer(registry, { id: 'fixture', command: 'node',
      args: [resolve('tests/fixtures/mcp-server.mjs')], allowedTools: ['echo', 'slow', 'stats'] });
    const context = invocation({ permissions: new Set(['mcp:fixture:echo', 'mcp:fixture:slow', 'mcp:fixture:stats']) });
    try {
      const result: any = await registry.invoke('fixture.echo', { text: 'actual MCP response' }, context);
      expect(result.structuredContent).toEqual({ text: 'actual MCP response' });
      await expect(registry.invoke('fixture.echo', { text: 12 }, context)).rejects.toThrow();
      await expect(registry.invoke('fixture.slow', { text: 'cancel fixture' }, { ...context, timeoutMs: 30 })).rejects.toThrow('timeout');
      let cancelled = false;
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        const state: any = await registry.invoke('fixture.stats', {}, context);
        cancelled = state.structuredContent.cancelled;
        if (!cancelled) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(cancelled).toBe(true);
      expect((await registry.invoke('fixture.echo', { text: 'still connected' }, context) as any).structuredContent.text).toBe('still connected');
    } finally { await close(); }
  });
});
