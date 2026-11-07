import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
if (prompt.includes('hold-child')) {
  writeFileSync('fixture.pid', String(process.pid));
  setInterval(() => {}, 1000);
} else if (prompt.includes('malformed-json')) {
  console.log('```json\n{invalid\n```');
} else if (prompt.includes('blocked-output')) {
  console.log('rm -rf /');
} else if (prompt.includes('reject-model')) {
  console.error('requested model unavailable');
  process.exitCode = 23;
} else {
  const usage = args[args.indexOf('--usage-output-file') + 1];
  if (!prompt.includes('missing-usage')) {
    writeFileSync(usage, JSON.stringify({ totalPremiumRequestCost: 1, totalNanoAiu: 123, modelMetrics: { 'fixture-provider-model': { requests: { count: 1 } } } }));
  }
  if (prompt.includes('text-response')) {
    if (!prompt.endsWith('explain fixture value')) throw new Error('Expected the prior JSON field');
    console.log('plain fixture response');
  }
  else console.log(JSON.stringify({ args, value: 'fixture value' }));
}
