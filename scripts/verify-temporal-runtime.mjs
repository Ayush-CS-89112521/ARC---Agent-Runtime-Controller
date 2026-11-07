import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { Worker, bundleWorkflowCode, Runtime, DefaultLogger } from '@temporalio/worker';
import proto from '@temporalio/proto';
const { temporal } = proto;
import { historyToJSON } from '@temporalio/common/proto-utils';
import { TemporalClient } from '../dist/src/temporal/client.js';

// This verifier intentionally cannot target an arbitrary/prod Temporal endpoint.
const address = '127.0.0.1:17233';
const namespace = 'arc-test';
const suite = `arc-verify-${randomUUID()}`;
const evidence = path.resolve('.audit/temporal', suite);
const root = await mkdtemp(path.join(tmpdir(), 'arc-temporal-verify-'));
await mkdir(evidence, { recursive: true });
const bundlePath = path.join(evidence, 'workflows.js');
const workers = new Set();
const results = [];
const histories = [];
let connection;
Runtime.install({ logger: new DefaultLogger('WARN') });

async function bounded(promise, ms = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Verification deadline ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function poll(fn, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error('Verification polling deadline exceeded');
}
async function startWorker(queue, config = {}) {
  const logfile = path.join(evidence, `worker-${workers.size}-${randomUUID()}.log`);
  const log = createWriteStream(logfile);
  const env = { ...process.env, ARC_TEMPORAL_FIXTURE_QUEUE: queue,
    ARC_TEMPORAL_FIXTURE_ROOT: root, ARC_TEMPORAL_FIXTURE_BUNDLE: bundlePath,
    ARC_WORKFLOW_ONLY: config.workflowOnly ? '1' : '0',
    ARC_HOLD_COMPLETION: config.holdCompletion ? '1' : '0',
    ARC_HOLD_CANCEL_ACK: config.holdCancelAck ? '1' : '0' };
  for (const key of ['DATABASE_URL', 'ARC_POSTGRES_ADMIN_PASSWORD', 'ARC_POSTGRES_APP_PASSWORD']) delete env[key];
  const child = fork(path.resolve('tests/fixtures/temporal-worker.mjs'), [], { env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const record = { child, events: [], logfile, log };
  workers.add(record);
  child.on('message', event => record.events.push(event));
  await poll(() => {
    if (child.exitCode !== null) throw new Error(`Worker startup failed: ${logfile}`);
    return record.events.some(event => event.phase === 'ready');
  }, 30000);
  return record;
}
async function stopWorker(record, crash = false) {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  const exited = once(record.child, 'exit');
  if (crash) record.child.kill('SIGKILL');
  else record.child.send('shutdown');
  try { await bounded(exited, 8000); }
  catch { record.child.kill('SIGKILL'); await bounded(exited, 5000); }
  record.log.end();
}
const eventFor = (worker, phase, workflowId) => poll(() => worker.events.find(event => event.phase === phase && (!workflowId || event.workflowId === workflowId)));
const workspaceFor = (handle) => path.join(root, createHash('sha256').update(`${namespace}/${handle.workflowId}/${handle.firstExecutionRunId}`).digest('hex'));
const step = (id, tool, input, when) => ({ id, name: id, prompt: 'Deterministic Temporal fixture', input,
  tools: [{ id: tool, name: tool, auth_type: 'none', category: 'verification' }],
  ...(when ? { when } : {}), safety: { pattern_scan: true, require_approval: tool.includes('write') || tool.includes('append'), timeout: 10000 },
  error_handling: { on_failure: 'stop_workflow', fallback_enabled: false },
  metadata: { tool_action: 'exact', confidence_score: 1, index: Number(id.split('_')[1]) } });
const workflow = steps => ({ name: 'deterministic-temporal-fixture', steps, metadata: {
  architect_plan_id: 'deterministic-no-model', confidence_score: 1, conversion_timestamp: new Date().toISOString(), tool_count: steps.length, hallucination_count: 0 } });
const writeRead = content => workflow([
  step('step_1', 'local.read_file', { path: 'result.txt' }, 'step_0_complete == true'),
  step('step_0', 'local.write_file', { path: 'result.txt', content }),
]);
const waitWorkflow = ms => workflow([step('step_0', 'fixture.wait', { ms }),
  step('step_1', 'local.write_file', { path: 'after-wait.txt', content: 'must-not-run-after-cancel' }, 'step_0_complete == true')]);
const options = (preparedWorkflow, extra = {}) => ({ request: 'Deterministic fixture; no model calls',
  preparedWorkflow, enableRAG: false, enableWebScraping: false, persistResults: false,
  autoApprove: true, activityTimeoutMs: 15000, heartbeatTimeoutMs: 1500, ...extra });
const eventNames = history => history.events.map(event => temporal.api.enums.v1.EventType[event.eventType]);
async function historyOf(handle, label) {
  const history = await handle.fetchHistory();
  const names = eventNames(history);
  const message = JSON.parse(historyToJSON(history));
  assert.equal(message.events.length, history.events.length);
  await writeFile(path.join(evidence, `${label}-history.json`), JSON.stringify(message, null, 2));
  histories.push({ label, workflowId: handle.workflowId, history });
  return { history, names };
}
async function runCase(name, fn) {
  const start = Date.now();
  try { const detail = await fn(); results.push({ name, status: 'PASS', durationMs: Date.now() - start, detail }); }
  catch (error) { results.push({ name, status: 'FAIL', durationMs: Date.now() - start, error: error.stack ?? String(error) }); }
  console.log(JSON.stringify(results[results.length - 1]));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ suite, address, namespace, results }, null, 2));
}

try {
  const bundle = await bundleWorkflowCode({ workflowsPath: path.resolve('tests/fixtures/temporal-workflows.mjs') });
  await writeFile(bundlePath, bundle.code);
  connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  const ns = await connection.workflowService.describeNamespace({ namespace });
  assert.equal(ns.namespaceInfo.name, namespace);
  const queue = `${suite}-normal`;
  const normal = await startWorker(queue);
  const api = new TemporalClient({ address, namespace, taskQueue: queue });
  const start = async (label, args, taskQueue = queue, workflowType = 'executeWorkflowDurable') => client.workflow.start(workflowType, {
    workflowId: `${suite}-${label}`, taskQueue, args: [args], workflowExecutionTimeout: 45000,
    workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL' });

  await runCase('server-worker-registration', async () => {
    const queues = await poll(async () => {
      const description = await connection.workflowService.describeTaskQueue({ namespace, taskQueue: { name: queue }, taskQueueType: 1 });
      return description.pollers.some(poller => poller.identity === `arc-verification-${normal.child.pid}`) ? description : undefined;
    }, 10000);
    assert.ok(queues.pollers.length > 0);
    return { server: 'SERVING', namespace, taskQueue: queue, pollers: queues.pollers.map(p => p.identity) };
  });
  await runCase('success-dependency-state-report-client-idempotency', async () => {
    const id = `${suite}-api-client`;
    const result = await bounded(api.startWorkflow(options(writeRead('actual-temporal-output'), { workflowId: id })));
    assert.equal(result.success, true);
    assert.deepEqual(result.results.map(result => result.step_id), ['step_0', 'step_1']);
    assert.deepEqual(result.results[1].output, { content: 'actual-temporal-output' });
    assert.deepEqual(result.stats, { totalSteps: 2, successfulSteps: 2, failedSteps: 0 });
    const handle = client.workflow.getHandle(id);
    const description = await handle.describe();
    assert.equal(description.status.name, 'COMPLETED');
    await assert.rejects(api.startWorkflow(options(writeRead('duplicate-must-not-run'), { workflowId: id })));
    const h = await historyOf(handle, 'success');
    assert.equal(h.names.filter(name => name === 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED').length, 1);
    assert.equal(await readFile(path.join(workspaceFor({ workflowId: id, firstExecutionRunId: description.runId }), 'result.txt'), 'utf8'), 'actual-temporal-output');
    return { stats: result.stats, duplicateWorkflowIdRejected: true };
  });
  for (const [label, prepared, extra, error] of [
    ['permission-rejected', workflow([step('step_0', 'local.write_file', { path: 'blocked.txt', content: 'blocked' })]), { permissionScope: ['files.read', 'ungranted'] }, 'Permission denied'],
    ['approval-rejected', workflow([step('step_0', 'local.write_file', { path: 'blocked.txt', content: 'blocked' })]), { autoApprove: false }, 'Approval required'],
    ['invalid-tool-input', workflow([step('step_0', 'local.write_file', { path: 123, content: 'blocked' })]), {}, ''],
    ['tool-failure', workflow([step('step_0', 'fixture.fail', {})]), {}, 'Controlled tool failure'],
  ]) await runCase(label, async () => {
    const handle = await start(label, options(prepared, extra));
    const result = await bounded(handle.result());
    assert.equal(result.success, false); assert.equal(result.stats.failedSteps, 1);
    assert.ok(result.errors.some(value => String(value.message).includes(error)));
    await assert.rejects(readFile(path.join(workspaceFor(handle), 'blocked.txt')));
    const h = await historyOf(handle, label);
    assert.ok(h.names.includes('EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED'));
    return { businessSuccess: result.success, failedSteps: result.stats.failedSteps };
  });
  await runCase('tool-timeout-stops-scheduling', async () => {
    const prepared = waitWorkflow(20000); prepared.steps[0].safety.timeout = 100;
    const handle = await start('tool-timeout', options(prepared));
    const result = await bounded(handle.result());
    assert.equal(result.success, false); assert.equal(result.results.length, 1);
    assert.match(result.errors[0].message, /timeout/i);
    await assert.rejects(readFile(path.join(workspaceFor(handle), 'after-wait.txt')));
    await historyOf(handle, 'tool-timeout'); return { stoppedAfterFirstStep: true };
  });
  await runCase('temporal-activity-timeout', async () => {
    const handle = await start('activity-timeout', options(waitWorkflow(20000), { activityTimeoutMs: 700 }));
    const result = await bounded(handle.result()); assert.equal(result.success, false);
    const h = await historyOf(handle, 'activity-timeout'); assert.ok(h.names.includes('EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT'));
    await assert.rejects(readFile(path.join(workspaceFor(handle), 'after-wait.txt')));
    return { activityTimeoutInHistory: true };
  });
  await runCase('cancellation-reaches-tool-and-server', async () => {
    const handle = await start('cancel', options(waitWorkflow(20000)));
    await eventFor(normal, 'wait-start', handle.workflowId);
    await api.cancelWorkflow(handle.workflowId);
    await assert.rejects(bounded(handle.result()));
    await eventFor(normal, 'cancelled', handle.workflowId);
    const h = await historyOf(handle, 'cancel'); assert.ok(h.names.includes('EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED'));
    await assert.rejects(readFile(path.join(workspaceFor(handle), 'after-wait.txt')));
    return { workflowStatus: (await handle.describe()).status.name, underlyingAbortObserved: normal.events.some(event => event.phase === 'wait-aborted') };
  });
  await runCase('concurrent-state-permission-cancellation-isolation', async () => {
    const entries = await Promise.all(['A', 'B', 'C'].map(async label => {
      const prepared = workflow([step('step_0', 'fixture.wait', { ms: 700 }),
        step('step_1', 'local.write_file', { path: 'same-name.txt', content: label }, 'step_0_complete == true'),
        step('step_2', 'local.read_file', { path: 'same-name.txt' }, 'step_1_complete == true')]);
      return { label, handle: await start(`concurrent-${label}`, options(prepared)) };
    }));
    const denied = await start('concurrent-denied', options(writeRead('denied'), { permissionScope: ['files.read'] }));
    const cancelled = await start('concurrent-cancelled', options(waitWorkflow(20000)));
    await eventFor(normal, 'wait-start', cancelled.workflowId); await cancelled.cancel();
    await assert.rejects(bounded(cancelled.result()));
    const outcomes = await Promise.all(entries.map(async ({ label, handle }) => {
      const result = await bounded(handle.result()); assert.equal(result.success, true);
      assert.deepEqual(result.results[2].output, { content: label });
      assert.equal(await readFile(path.join(workspaceFor(handle), 'same-name.txt'), 'utf8'), label);
      await historyOf(handle, `concurrent-${label}`); return { workflowId: handle.workflowId, workspace: workspaceFor(handle) };
    }));
    assert.equal(new Set(outcomes.map(value => value.workspace)).size, 3);
    assert.equal((await denied.result()).success, false);
    await historyOf(denied, 'concurrent-denied'); await historyOf(cancelled, 'concurrent-cancelled');
    return { independentWorkflows: 5, uniqueSuccessfulWorkspaces: 3 };
  });
  await api.disconnect(); await stopWorker(normal);

  await runCase('crash-before-activity-execution-restart-resumes', async () => {
    const queue = `${suite}-before`; const initial = await startWorker(queue, { workflowOnly: true });
    const handle = await start('crash-before', options(writeRead('resumed-after-worker-crash')), queue);
    await poll(async () => eventNames(await handle.fetchHistory()).includes('EVENT_TYPE_ACTIVITY_TASK_SCHEDULED'));
    assert.ok(!eventNames(await handle.fetchHistory()).includes('EVENT_TYPE_ACTIVITY_TASK_STARTED'));
    await stopWorker(initial, true);
    const replacement = await startWorker(queue);
    const result = await bounded(handle.result()); assert.equal(result.success, true);
    const h = await historyOf(handle, 'crash-before');
    assert.equal(h.names.filter(name => name === 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED').length, 1);
    await stopWorker(replacement); return { resumed: true, completedActivities: 1 };
  });
  for (const crashPoint of ['during-activity', 'after-side-effect', 'during-cancellation']) await runCase(`crash-${crashPoint}`, async () => {
    const queue = `${suite}-${crashPoint}`;
    const initial = await startWorker(queue, { holdCompletion: crashPoint === 'after-side-effect', holdCancelAck: crashPoint === 'during-cancellation' });
    const prepared = crashPoint === 'after-side-effect'
      ? workflow([step('step_0', 'local.write_file', { path: 'committed-effect.txt', content: 'one-side-effect' })]) : waitWorkflow(20000);
    const handle = await start(`crash-${crashPoint}`, options(prepared), queue);
    const marker = await eventFor(initial, crashPoint === 'after-side-effect' ? 'completed' : 'wait-start', handle.workflowId);
    if (crashPoint === 'during-cancellation') { await handle.cancel(); await eventFor(initial, 'cancelled', handle.workflowId); }
    if (crashPoint === 'after-side-effect') {
      assert.equal(await readFile(path.join(marker.workspace, 'committed-effect.txt'), 'utf8'), 'one-side-effect');
      assert.ok(!eventNames(await handle.fetchHistory()).includes('EVENT_TYPE_ACTIVITY_TASK_COMPLETED'));
    }
    await stopWorker(initial, true);
    const replacement = await startWorker(queue);
    if (crashPoint === 'during-cancellation') {
      await assert.rejects(bounded(handle.result()));
      const h = await historyOf(handle, `crash-${crashPoint}`);
      assert.ok(h.names.includes('EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED'));
    } else {
      const result = await bounded(handle.result()); assert.equal(result.success, false);
      const h = await historyOf(handle, `crash-${crashPoint}`);
      assert.ok(h.names.includes('EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT'));
      assert.equal(replacement.events.filter(event => event.phase === 'started' && event.workflowId === handle.workflowId).length, 0);
      if (crashPoint === 'after-side-effect') {
        assert.equal(await readFile(path.join(marker.workspace, 'committed-effect.txt'), 'utf8'), 'one-side-effect');
        await writeFile(path.join(evidence, 'crash-side-effect-observation.txt'), 'Existing side effect retained; no retry; no activity completion; outcome requires reconciliation.');
      }
    }
    await stopWorker(replacement);
    return { status: (await handle.describe()).status.name, automaticActivityRetry: false, sideEffectRepeated: false };
  });
  await runCase('unsafe-retry-demonstrates-duplicate-side-effects', async () => {
    const queue = `${suite}-unsafe-retry`; const initial = await startWorker(queue, { holdCompletion: true });
    const prepared = workflow([step('step_0', 'fixture.append', {})]);
    const handle = await start('unsafe-retry', options(prepared), queue, 'unsafeRetryDemonstration');
    const marker = await eventFor(initial, 'completed', handle.workflowId);
    await stopWorker(initial, true);
    const replacement = await startWorker(queue);
    const result = await bounded(handle.result()); assert.equal(result.status, 'success');
    const effects = (await readFile(path.join(marker.workspace, 'effects.log'), 'utf8')).trim().split('\n');
    assert.deepEqual(effects, ['effect-attempt-1', 'effect-attempt-2']);
    await writeFile(path.join(evidence, 'unsafe-retry-effects.txt'), effects.join('\n'));
    await historyOf(handle, 'unsafe-retry');
    await stopWorker(replacement); return { deliberatelyUnsafeFixtureOnly: true, observedSideEffects: effects.length, productionMaximumAttempts: 1 };
  });
  await runCase('journaled-write-recovers-after-worker-crash-before-acknowledgement', async () => {
    const queue = `${suite}-journal-retry`;
    const initial = await startWorker(queue, { holdCompletion: true });
    const prepared = workflow([step('step_0', 'local.write_file', { path: 'one.txt', content: 'journal-owned' })]);
    const handle = await start('journal-retry', options(prepared), queue, 'unsafeRetryDemonstration');
    const marker = await eventFor(initial, 'completed', handle.workflowId);
    const destination = path.join(marker.workspace, 'one.txt');
    const original = await stat(destination, { bigint: true });
    await stopWorker(initial, true);
    const replacement = await startWorker(queue);
    const result = await bounded(handle.result());
    assert.equal(result.status, 'success');
    const recovered = await stat(destination, { bigint: true });
    assert.equal(recovered.ino, original.ino);
    assert.equal(recovered.mtimeNs, original.mtimeNs);
    assert.equal(await readFile(destination, 'utf8'), 'journal-owned');
    const { history } = await historyOf(handle, 'journal-retry');
    const started = history.events.find(event => event.activityTaskStartedEventAttributes);
    assert.equal(started.activityTaskStartedEventAttributes.attempt, 2);
    await stopWorker(replacement);
    return { status: result.status, attempt: 2, originalInodePreserved: true, contentPreserved: true };
  });
  await runCase('history-replay', async () => {
    for (const { label, workflowId } of histories) {
      const saved = JSON.parse(await readFile(path.join(evidence, `${label}-history.json`), 'utf8'));
      await Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, saved, workflowId);
    }
    return { historiesReplayed: histories.length };
  });
} finally {
  for (const worker of workers) {
    await stopWorker(worker).catch(() => {});
    await writeFile(`${worker.logfile}.events.json`, JSON.stringify(worker.events, null, 2));
  }
  await connection?.close();
  await writeFile(path.join(evidence, 'histories-index.json'), JSON.stringify(histories.map(value => ({
    label: value.label, workflowId: value.workflowId, eventCount: value.history.events.length,
  })), null, 2));
  // Only remove the exact mkdtemp-owned workspace, after validating its absolute parent/prefix.
  assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith('arc-temporal-verify-'));
  await rm(root, { recursive: true, force: true });
  await writeFile(path.resolve('.audit/temporal/latest.json'), JSON.stringify({ evidence, suite, results }, null, 2));
}
console.log(`Temporal verification evidence: ${evidence}`);
if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
