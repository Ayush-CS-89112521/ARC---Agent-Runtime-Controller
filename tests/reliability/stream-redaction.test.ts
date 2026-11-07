import { expect, it } from 'bun:test';
import { StreamRedactor } from '../../arc/src/sanitizer';

it('masks tokens at every two-chunk boundary and one byte at a time', () => {
  const secret = 'sk-proj-' + 'a'.repeat(48);
  const raw = `hello 😀 api_key=${secret}\n`;
  const bytes = Buffer.from(raw);
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    const redactor = new StreamRedactor();
    const output = redactor.write(bytes.subarray(0, boundary)) + redactor.write(bytes.subarray(boundary)) + redactor.end();
    expect(output).not.toContain(secret);
    expect(output).toContain('hello 😀');
    expect(output).toContain('[REDACTED]');
  }
  const redactor = new StreamRedactor();
  const output = [...bytes].map(byte => redactor.write(Uint8Array.of(byte))).join('') + redactor.end();
  expect(output).not.toContain(secret);
});

it('handles generic assignments, multiple secrets, multiline keys, completion and cancellation', () => {
  const redactor = new StreamRedactor();
  let output = redactor.write('api_ke');
  expect(output).toBe('');
  output += redactor.write('y=FIXTURE_SECRET password="OTHER_FIXTURE"\n');
  output += redactor.write('Authorization: Bearer OPAQUE_FIXTURE_CREDENTIAL\n');
  output += redactor.write('-----BEGIN PRIVATE KEY-----\nFIXTURE_KEY_MATERIAL\n');
  output += redactor.write('-----END PRIVATE KEY-----\nordinary text');
  output += redactor.end();
  expect(output).not.toContain('FIXTURE_SECRET');
  expect(output).not.toContain('OTHER_FIXTURE');
  expect(output).not.toContain('OPAQUE_FIXTURE_CREDENTIAL');
  expect(output).not.toContain('FIXTURE_KEY_MATERIAL');
  expect(output).toContain('ordinary text');
  const cancelled = new StreamRedactor();
  cancelled.write('api_key=INCOMPLETE_FIXTURE');
  cancelled.cancel();
  expect(cancelled.end()).toBe('');
  const incompleteKey = new StreamRedactor();
  const incompleteOutput = incompleteKey.write('-----BEGIN PRIVATE KEY-----\nUNFINISHED_FIXTURE_KEY') + incompleteKey.end();
  expect(incompleteOutput).not.toContain('UNFINISHED_FIXTURE_KEY');
  expect(incompleteKey.end()).toBe(''); // completion must not generate output forever on beforeExit
});

it('fails closed on oversized unterminated lines and preserves subsequent output', () => {
  const redactor = new StreamRedactor();
  const output = redactor.write('api_key=' + 'x'.repeat(100000)) + redactor.write('\nnormal\n') + redactor.end();
  expect(output).not.toContain('x'.repeat(100));
  expect(output).toContain('normal');
});

it('intercepts actual stdout/stderr writes and flushes safely on explicit exit', async () => {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/stream-output.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0);
  expect(stdout).toContain('fixture 😀');
  expect(stdout).toContain('[REDACTED]');
  expect(stdout).not.toContain('FIXTURE_NOT_A_REAL_KEY');
  expect(stderr).not.toContain('OTHER_FIXTURE');
  expect(stderr).toContain('[REDACTED]');
});
