import { Reporter, type Tool } from './ui/index.js';

// Flags: --dry-run  --yes  --fail
const flags = new Set(process.argv.slice(2));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tools: Tool[] = [
  {
    title: 'Resolve workspace',
    commands: ['arc resolve --workspace .'],
    run: () => sleep(220),
  },
  {
    title: 'Install dependencies',
    commands: ['pnpm install --frozen-lockfile'],
    run: () => sleep(840),
  },
  {
    title: 'Type-check',
    commands: ['tsc --noEmit'],
    async run() {
      await sleep(610);
      return { warning: '3 deprecated APIs found. They still work, but plan to replace them.' };
    },
  },
  {
    title: 'Run tests',
    commands: ['vitest run'],
    async run() {
      await sleep(720);
      if (flags.has('--fail')) throw new Error('2 tests failed in src/api.test.ts');
    },
    suggest: 'Open src/api.test.ts and check whether the response shape changed, then re-run.',
  },
  {
    title: 'Deploy to production',
    risk: 'high',
    commands: ['git push origin main', 'vercel deploy --prod'],
    run: () => sleep(900),
  },
];

const ui = new Reporter({
  version: '0.4.0',
  dryRun: flags.has('--dry-run'),
  yes: flags.has('--yes'),
});

ui.banner();
const summary = await ui.run(tools);
process.exitCode = summary.failed > 0 || summary.aborted ? 1 : 0;
