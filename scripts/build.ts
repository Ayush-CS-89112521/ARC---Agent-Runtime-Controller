import { mkdir, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const check = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);
await mkdir('dist', { recursive: true });
const result = await Bun.build({ entrypoints: ['src/cli.ts'], target: 'bun', outdir: 'dist', naming: 'cli.js' });
if (!result.success) { console.error(result.logs); process.exit(1); }
if (process.platform !== 'win32') await chmod('dist/cli.js', 0o755);
