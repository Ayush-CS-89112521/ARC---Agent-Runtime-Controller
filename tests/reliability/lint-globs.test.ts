import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('ESLint and its TypeScript project service retain glob behavior with patched minimatch', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/verify-lint-globs.mjs', import.meta.url));
  const child = Bun.spawn(['node', fixture], { stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(12000) });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr || stdout || `Lint fixture exited ${code}`);
  expect(stdout).toContain('TypeScript project-service allowlist passed');
}, 15000);
