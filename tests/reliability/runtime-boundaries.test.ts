import { describe, expect, it } from 'bun:test';
import { BuilderAgent } from '../../src/agents/builder';
import { convertBuilderResultToReport, initializeBridgeContext } from '../../src/engine/orchestration-bridge';
import { ArchitectAgent } from '../../src/agents/architect';
import { ToolRegistry } from '../../arc/src/registry';
import { z } from 'zod';
import { PlanConverter } from '../../src/parsers/plan-converter';
import { AutoSwitchOrchestrator } from '../../src/engine/auto-switch-orchestrator';

const step = (id = 'step_0', when?: string): any => ({
  id, name: id, prompt: 'harmless fixture', tools: [{ id: 'fixture', name: 'Fixture' }],
  safety: { timeout: 100 }, error_handling: { on_failure: 'stop_workflow' }, when,
});
const workflow = (steps: any[]): any => ({ name: 'boundary-fixture', steps });

describe('Runtime boundary regressions', () => {
  it('traverses A -> approval -> conversion -> Builder, and stops on rejection', async () => {
    const events: string[] = [];
    const plan: any = { request_summary: 'fixture', confidence_score: 1, steps: [{ step_id: 10, step_name: 'first',
      tool_needed: 'fixture', reasoning: 'fixture', dependencies: [] }] };
    const orchestrator: any = new AutoSwitchOrchestrator({ autoApprove: true, permissions: ['tool:fixture'] });
    orchestrator.architectService = { createPlanFromRequest: async () => { events.push('A'); return plan; } };
    orchestrator.planConverter = new PlanConverter([{ id: 'fixture', name: 'Fixture', category: 'test', authType: 'none' }] as any);
    orchestrator.checkpointHandler = { autoApprove: async () => { events.push('B'); return { approved: true, action: 'approve' }; } };
    orchestrator.toolPruner = { getToolById: () => { events.push('C'); return undefined; } };
    orchestrator.builderAgent = new BuilderAgent(new Map([['fixture', { id: 'fixture', name: 'Fixture', execute: async () => { events.push('D'); return 'ok'; } }]]));
    expect((await orchestrator.executeFullPipeline('fixture')).result.status).toBe('success');
    expect(events).toEqual(['A', 'B', 'C', 'D']);
    events.length = 0;
    orchestrator.checkpointHandler.autoApprove = async () => { events.push('reject'); return { approved: false, action: 'reject' }; };
    await expect(orchestrator.executeFullPipeline('fixture')).rejects.toThrow('rejected');
    expect(events).toEqual(['A', 'reject']);
  });

  it('rejects ambiguous ARC confirmation flags and non-object input before execution', async () => {
    for (const args of [['run', 'git.safe_branch', '--name', 'feat/fixture', '--yes=false', '--json'],
      ['run', 'env.audit', '--input', 'null', '--json'], ['run', 'env.audit', '--input', '[]', '--json']]) {
      const child = Bun.spawn([process.execPath, 'arc/src/cli.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(1);
    }
  });
  it('preserves Architect step identities across conversion and Builder traversal', async () => {
    const converter = new PlanConverter([{ id: 'fixture', name: 'Fixture', description: 'fixture', category: 'test', authType: 'none', scope: 'read-only' }] as any);
    const conversion = await converter.convert({ request_summary: 'fixture', confidence_score: 1,
      steps: [{ step_id: 10, step_name: 'first', tool_needed: 'fixture', reasoning: 'fixture', dependencies: [] },
        { step_id: 20, step_name: 'second', tool_needed: 'fixture', reasoning: 'fixture', dependencies: [10] }],
    } as any);
    expect(conversion.workflow.steps[1].when).toBe('step_0_complete == true');
    const builder = new BuilderAgent(new Map([['fixture', { id: 'fixture', name: 'Fixture', execute: async () => 'ok' }]]));
    const result = await builder.execute(conversion.workflow, { permissions: new Set(['tool:fixture']) });
    expect(result.status).toBe('success');
    expect(result.step_results.map(step => step.step_id)).toEqual(['step_0', 'step_1']);
  });
  it('terminates on tool timeout and skips dependent work', async () => {
    const builder = new BuilderAgent(new Map([['fixture', { id: 'fixture', name: 'Fixture',
      execute: () => new Promise(() => {}),
    }]]));
    const first = step(); first.safety.timeout = 10;
    const result = await builder.execute(workflow([first, step('step_1', 'step_0_complete == true')]), { permissions: new Set(['tool:fixture']) });
    expect(result.status).toBe('failed');
    expect(result.steps_executed).toBe(1);
    expect(result.errors[0].message).toContain('timeout');
  });

  it('keeps concurrently executing workflow state separate', async () => {
    const seen: number[] = [];
    const builder = new BuilderAgent(new Map([['fixture', { id: 'fixture', name: 'Fixture',
      execute: async (_: string, context: any) => { seen.push(context.stepResults.size); return 'ok'; },
    }]]));
    const results = await Promise.all([builder.execute(workflow([step()]), { permissions: new Set(['tool:fixture']) }), builder.execute(workflow([step()]), { permissions: new Set(['tool:fixture']) })]);
    expect(seen).toEqual([0, 0]);
    expect(results.every(result => result.status === 'success')).toBe(true);
  });

  it('rejects dependency cycles and duplicate step identities', async () => {
    await expect(new BuilderAgent().execute(workflow([step('step_0', 'step_1_complete == true'), step('step_1', 'step_0_complete == true')]))).rejects.toThrow('Circular');
    await expect(new BuilderAgent().execute(workflow([step(), step()]))).rejects.toThrow('Duplicate');
  });

  it('rejects unknown tools and dependency order errors in model plans', () => {
    const plan: any = { steps: [{ step_id: 1, step_name: 'first', tool_needed: 'unknown', dependencies: [2] },
      { step_id: 2, step_name: 'second', tool_needed: 'fixture', dependencies: [] }], total_steps: 2, execution_order: [1, 2] };
    const validation = new ArchitectAgent().validatePlan(plan, { pruned_tools: [{ id: 'fixture' }] } as any);
    expect(validation.is_valid).toBe(false);
    expect(validation.errors.some(error => error.includes('Dependency order'))).toBe(true);
    expect(validation.errors.some(error => error.includes('not found'))).toBe(true);
  });

  it('enforces registry schemas, confirmation, dry runs, and tool errors', async () => {
    let calls = 0;
    const registry = new ToolRegistry().register({ id: 'fixture', name: 'fixture', description: 'fixture',
      schema: z.object({ value: z.string() }), risk: 'medium', dryRun: async () => 'preview',
      execute: async () => { calls++; throw new Error('controlled failure'); },
    } as any);
    expect((await registry.run('missing', {}, { mode: 'execute' })).ok).toBe(false);
    expect((await registry.run('fixture', {}, { mode: 'execute' })).ok).toBe(false);
    expect((await registry.run('fixture', { value: 'ok' }, { mode: 'execute' })).ok).toBe(false);
    expect((await registry.run('fixture', { value: 'ok' }, { mode: 'dry-run' })).ok).toBe(true);
    expect(calls).toBe(0);
    expect((await registry.run('fixture', { value: 'ok' }, { mode: 'execute', confirmed: true })).ok).toBe(false);
    expect(calls).toBe(1);
  });
  it('does not report success for an unregistered tool', async () => {
    const result = await new BuilderAgent().execute(workflow([step()]));
    expect(result.status).toBe('failed');
    expect(result.errors[0].message).toContain('not registered');
  });

  it('executes registered tools and propagates state to dependent tools', async () => {
    const calls: string[] = [];
    const builder = new BuilderAgent(new Map([['fixture', {
      id: 'fixture', name: 'Fixture', execute: async (_: string, context: any) => {
        calls.push(...context.stepResults.keys());
        return { value: 42 };
      },
    }]]));
    const denied = await builder.execute(workflow([step()]));
    expect(denied.status).toBe('failed');
    expect(calls).toEqual([]);
    const result = await builder.execute(workflow([step(), step('step_1', 'step_0_complete == true')]), { permissions: new Set(['tool:fixture']) });
    expect(result.status).toBe('success');
    expect(calls).toEqual(['step_0']);
    expect(result.step_results[1].output).toEqual({ value: 42 });
  });

  it('fails closed for malformed conditions', async () => {
    const result = await new BuilderAgent().execute(workflow([step('step_0', 'nonsense')]));
    expect(result.status).toBe('failed');
    expect(result.errors[0].message).toContain('condition');
  });

  it('rejects missing dependency references with a useful error', async () => {
    await expect(new BuilderAgent().execute(workflow([step('step_0', 'step_999_complete == true')]))).rejects.toThrow('Unknown dependency');
  });

  it('maps Builder output to the actual engine result contract', () => {
    const wf = workflow([step()]);
    const context = initializeBridgeContext(wf, {});
    const result: any = { status: 'failed', step_results: [{ step_id: 'step_0', status: 'failed',
      output: undefined, duration_ms: 1, timestamp: '2026-11-07T00:00:00Z', error: { message: 'fixture failure' } }],
      errors: [], total_steps: 1, execution_time_ms: 1, summary: { successful_steps: 0, failed_steps: 1 } };
    const report = convertBuilderResultToReport(wf, result, context);
    expect(report.context.results[0].success).toBe(false);
    expect(report.context.results[0].timestamp).toBeInstanceOf(Date);
    expect(report.context.results[0].error).toBe('fixture failure');
    expect(report.context.results[0].output).toBe('');
    expect(report.context.results[0].retriesAttempted).toBe(0);
  });
});
