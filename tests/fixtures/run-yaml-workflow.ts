import { stat } from 'node:fs/promises';
import { executeWorkflow } from '../../src/engine/workflow-engine.js';
import { loadWorkflowFromFile } from '../../src/parsers/workflow-parser.js';

const fixture = process.argv[2]!;
const controller = new AbortController();
const timer = process.argv.includes('cancel') ? setInterval(async () => {
  if (await stat('fixture.pid').catch(() => undefined)) controller.abort(new Error('fixture cancelled'));
}, 20) : undefined;
try {
const report = await executeWorkflow(await loadWorkflowFromFile('workflow.yaml'), {
  signal: controller.signal,
  copilotCommand: [process.execPath, fixture],
});
console.log('FIXTURE_REPORT=' + JSON.stringify(report));
} finally { clearInterval(timer); }
