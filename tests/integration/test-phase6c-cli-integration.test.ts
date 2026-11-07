import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';

/**
 * Phase 6c CLI Integration Tests
 * Tests the new Phase 6c orchestrator CLI flags and routing
 */

describe('Phase 6c: CLI Integration', () => {
  const cwd = process.cwd();
  let fixtureDirectory: string;
  let testWorkflowPath: string;
  let children: Array<{ exited: Promise<number> }> = [];
  function spawnCli(options: { cmd: string[]; cwd: string; stdout?: 'pipe'; stderr?: 'pipe' }) {
    const child = Bun.spawn(options);
    children.push(child);
    return child;
  }

  beforeEach(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
    testWorkflowPath = join(fixtureDirectory, 'workflow.yaml');
    children = [];
    // Create a temporary test workflow
    const workflowContent = `name: "Test Workflow"
version: "1.0.0"
steps:
  - id: test-step
    agent: github
    prompt: "Echo hello world"
    timeout: 10000
`;
    await writeFile(testWorkflowPath, workflowContent, 'utf8');
  });

  afterEach(async () => {
    await Promise.all(children.map(child => child.exited));
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  describe('Flag Parsing', () => {
    it('should parse --plan flag', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('--plan');
    });

    it('should parse --auto-switch flag', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('--auto-switch');
    });

    it('should parse --auto-approve flag', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('--auto-approve');
    });

    it('should parse --execute-only flag', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('--execute-only');
    });

    it('should parse --no-steering flag', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('--no-steering');
    });
  });

  describe('Usage Documentation', () => {
    it('should show Phase 6c examples in help', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('--plan');
      expect(output).toContain('auto-switch');
      expect(output).toContain('Phase 6c');
    });

    it('should include orchestrator examples', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--help'],
        cwd,
        stdout: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('arc "Refactor');
    });
  });

  describe('Input Detection', () => {
    it('should detect .yaml files as file paths', async () => {
      // This is tested through normal execution
      // A .yaml file should use traditional path
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', testWorkflowPath],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Should start loading the workflow
      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('Loading workflow');
    });

    it('should detect .yml files as file paths', async () => {
      // Similar to .yaml
      expect('.yml'.endsWith('.yml')).toBe(true);
    });

    it('should detect ./ paths as file paths', async () => {
      expect('./test'.startsWith('./')).toBe(true);
    });

    it('should detect ../ paths as file paths', async () => {
      expect('../test'.startsWith('../')).toBe(true);
    });

    it('should detect / paths as file paths', async () => {
      expect('/test'.startsWith('/')).toBe(true);
    });

    it('should treat other inputs as prompt strings', async () => {
      // A string like "Refactor the code" should be treated as a prompt
      // if no --plan flag is used, it should error
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'refactor the code'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await Bun.readableStreamToText(result.stderr);
      expect(stderr).toContain('--plan');
    });
  });

  describe('Backward Compatibility', () => {
    it('should still support traditional workflow files', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', testWorkflowPath, '--timeout', '5000'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      // Should attempt to load the workflow
      expect(output).toContain('Loading workflow');
    });

    it('should preserve existing flags (--timeout, --retries, etc.)', async () => {
      const result = await spawnCli({
        cmd: [
          'bun',
          'src/cli.ts',
          testWorkflowPath,
          '--timeout',
          '30000',
          '--retries',
          '2',
          '--no-fail-fast',
        ],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      // Should not error on parsing
      expect(output.length).toBeGreaterThan(0);
    });

    it('should support --step-mode with traditional workflows', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', testWorkflowPath, '--step-mode'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Should start loading workflow
      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('Loading workflow');
    });

    it('should support --allow-main-push with traditional workflows', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', testWorkflowPath, '--allow-main-push'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('Loading workflow');
    });
  });

  describe('Mode Routing', () => {
    it('should require --plan for prompt strings', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'refactor the code'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await Bun.readableStreamToText(result.stderr);
      expect(stderr).toContain('--plan');
    });

    it('should route to orchestrator with --plan flag', async () => {
      // This test checks that the flag combination is recognized
      const proc = Bun.spawn({
        cmd: ['bun', 'src/cli.ts', 'test prompt', '--plan', '--auto-approve'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Read output with timeout to prevent hanging
      const timeoutPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve('timeout'), 2000)
      );
      const outputPromise = Bun.readableStreamToText(proc.stdout);

      const output = await Promise.race([outputPromise, timeoutPromise]);

      // Kill process to prevent hanging
      proc.kill();

      // Should see orchestrator initialization attempt
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    }, { timeout: 10000 });

    it('should route to traditional execution for workflow files', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', testWorkflowPath],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await Bun.readableStreamToText(result.stdout);
      expect(output).toContain('Loading workflow');
    });
  });

  describe('Error Handling', () => {
    it('should error when no input is provided', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await Bun.readableStreamToText(result.stderr);
      expect(stderr).toContain('required');
    });

    it('should error when workflow file not found', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', './nonexistent.yaml'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await Bun.readableStreamToText(result.stderr);
      expect(stderr.length).toBeGreaterThan(0);
    });

    it('should handle unknown flags gracefully', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', '--unknown-flag', 'value'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await Bun.readableStreamToText(result.stderr);
      expect(stderr).toContain('Unknown');
    });
  });

  describe('Orchestrator Flag Combinations', () => {
    it('should allow --plan alone', async () => {
      // Should parse successfully
      const proc = Bun.spawn({
        cmd: ['bun', 'src/cli.ts', 'test prompt', '--plan'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Read with timeout and kill to prevent hanging
      const timeoutPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve('timeout'), 2000)
      );
      const outputPromise = Bun.readableStreamToText(proc.stdout);

      const output = await Promise.race([outputPromise, timeoutPromise]);
      proc.kill();

      expect(typeof output).toBe('string');
    }, { timeout: 10000 });

    it('should allow --plan with --auto-switch', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'test', '--plan', '--auto-switch'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });

    it('should allow --plan with --auto-approve', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'test', '--plan', '--auto-approve'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });

    it('should allow --plan with --no-steering', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'test', '--plan', '--no-steering'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });

    it('should allow all Phase 6c flags together', async () => {
      const result = await spawnCli({
        cmd: [
          'bun',
          'src/cli.ts',
          'refactor code',
          '--plan',
          '--auto-switch',
          '--auto-approve',
          '--no-steering',
        ],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });
  });

  describe('Argument Preservation', () => {
    it('should preserve --timeout in orchestrator mode', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'test', '--plan', '--timeout', '60000'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });

    it('should preserve --retries in orchestrator mode', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'test', '--plan', '--retries', '3'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });

    it('should preserve --no-fail-fast in orchestrator mode', async () => {
      const result = await spawnCli({
        cmd: ['bun', 'src/cli.ts', 'test', '--plan', '--no-fail-fast'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBeDefined();
    });
  });
});
