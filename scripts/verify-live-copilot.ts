import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AutoSwitchOrchestrator } from '../src/engine/auto-switch-orchestrator.js';
import { ArchitectService } from '../src/services/architect-service.js';
import { ArchitectAgent } from '../src/agents/architect.js';
import { ExecutableRegistry } from '../src/tools/executable-registry.js';
import { registerLocalTools } from '../src/tools/local-adapters.js';
import { runCopilotPlanner } from '../src/execution/copilot-planner-client.js';
import { initializeBridgeContext, convertBuilderResultToReport } from '../src/engine/orchestration-bridge.js';
import { sanitize } from '../arc/src/sanitizer.js';

if (process.env.ARC_LIVE_COPILOT_REQUESTS !== '3') throw new Error('Explicitly enable the approved maximum of 3 live requests');
const project = process.cwd();
const evidence = resolve('.audit/live-copilot');
await mkdir(evidence, { recursive: true });
let requests = 0;
const results: Array<Record<string, unknown>> = [];
const scenarios = ['approved', 'approval-rejected', 'permission-denied'] as const;

for (const scenario of scenarios) {
  const workspace = await mkdtemp(join(tmpdir(), 'arc-live-copilot-'));
  const start = Date.now();
  const filename = `${scenario}.txt`;
  const content = 'ARC_LIVE_VERIFIED';
  try {
    process.chdir(workspace);
    const registry = registerLocalTools(new ExecutableRegistry(), workspace);
    const runner = async (prompt: string, signal?: AbortSignal) => {
      if (requests >= 3) throw new Error('Live request budget exhausted');
      requests++;
      try {
        const output = await runCopilotPlanner(prompt, signal, { cwd: workspace,
          usageFile: join(evidence, `request-${requests}-usage.json`) });
        await writeFile(join(evidence, `request-${requests}-response.json`), sanitize(output));
        return output;
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
        await writeFile(join(evidence, `request-${requests}-error.log`), sanitize(`${diagnostic}\n${stderr}`));
        throw error;
      }
    };
    const agent = new ArchitectAgent({}, runner);
    const service = new ArchitectService({}, registry.catalog(), agent);
    // The orchestration pipeline uses its normal services except the real CLI runner's evidence paths.
    const orchestrator = new AutoSwitchOrchestrator({ autoApprove: scenario !== 'approval-rejected',
      permissions: scenario === 'permission-denied' ? ['files.read'] : ['files.write', 'files.read'] }, registry);
    const planning = await service.createPlanFromRequest(
      `Return a plan only; do not perform any action yourself. Create exactly the new file ${filename} ` +
      `using local.write_file with input {"path":"${filename}","content":"${content}"}. ` +
      (scenario === 'approved' ? `Then read ${filename} using local.read_file with input {"path":"${filename}"}; make that step depend on the write step. ` : '') +
      'Use only these requested steps, exact paths and literal content; no shell commands.');
    if ('error_code' in planning) throw new Error(`Live planning failed: ${planning.error_code}`);
    const decision = await orchestrator.phaseB_ValidateWithSteering(planning);
    const steps = await orchestrator.phaseC_ConvertAndInjectTools(planning, decision);
    const result = await orchestrator.phaseD_ExecuteWithBuilder(steps);
    if (scenario === 'approved') {
      assert.equal(result.status, 'success');
      assert.equal(await readFile(join(workspace, filename), 'utf8'), content);
      assert.equal(result.step_results.length, 2);
      assert.deepEqual(result.step_results[1]?.output, { content });
      const workflow = { name: 'live-proof', steps, metadata: {
        architect_plan_id: planning.plan_id, confidence_score: planning.confidence_score,
        conversion_timestamp: new Date().toISOString(), tool_count: steps.length, hallucination_count: 0 } };
      const report = convertBuilderResultToReport(workflow, result, initializeBridgeContext(workflow, {}));
      assert.equal(report.success, true);
      assert.equal(report.stats.successfulSteps, 2);
      results.push({ scenario, status: 'PASS', durationMs: Date.now() - start, steps: report.stats.successfulSteps });
    } else {
      assert.equal(scenario, 'permission-denied');
      assert.equal(result.status, 'failed');
      assert.match(result.errors[0]?.message ?? '', /Permission denied/);
      await assert.rejects(readFile(join(workspace, filename)));
      results.push({ scenario, status: 'PASS', durationMs: Date.now() - start, terminalState: 'failed-as-expected' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (scenario === 'approval-rejected' && /Plan rejected by user/.test(message)) {
      await assert.rejects(readFile(join(workspace, filename)));
      results.push({ scenario, status: 'PASS', durationMs: Date.now() - start, terminalState: 'rejected-before-execution' });
    } else {
      results.push({ scenario, status: 'FAIL', durationMs: Date.now() - start, error: sanitize(message) });
    }
  } finally {
    process.chdir(project);
    await rm(workspace, { recursive: true, force: true });
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ requests, results }, null, 2));
  }
  console.log(JSON.stringify(results[results.length - 1]));
}
if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
