/**
 * Step Executor - Executes individual workflow steps
 * Handles Copilot prompt-mode invocation and output processing
 * Monitors resource usage to prevent runaway processes
 * Integrates with SpinnerManager for visual progress feedback
 * 
 * Layer 8: Audit Trail Integration
 * - Track tool usage per step execution
 * - Log tool availability at execution time
 * - Record resource limits applied
 * - Generate tool usage summary for post-workflow analysis
 */

import { copilotPromptArgs } from './copilot-planner-client.js';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ExecutionContext,
  WorkflowStep,
  StepResult,
} from '../types/index.js';
import { resolvePrompt } from './variable-resolver.js';
import { getRunDirectory } from '../context/context-manager.js';
import { spawnMonitored } from './resource-watchdog.js';
import { SpinnerManager } from '../ui/spinner-manager.js';
import type { ToolDescriptor } from '../types/tool-discovery.js';

/**
 * Error thrown when step execution fails
 */
export class StepExecutionError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    public readonly attemptNumber: number = 1
  ) {
    super(message);
    this.name = 'StepExecutionError';
  }
}

/**
 * Estimate token count in prompt (rough approximation)
 * Uses heuristic: ~1 token per 4 characters (conservative estimate)
 * 
 * @param text - Text to tokenize
 * @returns Estimated token count
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Select optimal model based on prompt complexity
 * The configured tier wins. Otherwise, edit tasks and long prompts request Sonnet.
 *
 * @param prompt - Prompt text
 * @param agent - Agent type ('suggest', 'explain', 'edit')
 * @param stepModel - Explicit model override from step config
 * @returns 'haiku' or 'sonnet'
 */
function selectModel(
  prompt: string,
  agent: string,
  stepModel?: 'haiku' | 'sonnet'
): 'haiku' | 'sonnet' {
  // Step-level override takes precedence
  if (stepModel) {
    return stepModel;
  }

  // Estimate tokens in prompt
  const tokenCount = estimateTokenCount(prompt);

  // Complexity factors:
  // 1. Prompt length: >3K tokens suggests complex task
  // 2. Agent type: 'edit' is inherently more complex
  const isComplexLength = tokenCount > 3000;
  const isEditAgent = agent === 'edit';

  // If either complexity signal detected, use Sonnet
  if (isComplexLength || isEditAgent) {
    return 'sonnet';
  }

  // Default to Haiku
  return 'haiku';
}

const MODEL_IDS = { haiku: 'claude-haiku-4.5', sonnet: 'claude-sonnet-4.5' } as const;

async function invokeGhCopilot(
  prompt: string, step: WorkflowStep, memoryMB: number, cpuWarnPercent: number,
  tier: keyof typeof MODEL_IDS, signal?: AbortSignal, command: readonly string[] = ['gh'],
): Promise<{ output: string; reportedModels: string[]; copilotUsage: StepResult['copilotUsage'] }> {
  signal?.throwIfAborted();
  const temp = await mkdtemp(join(tmpdir(), 'arc-copilot-'));
  try {
    const usageFile = join(temp, 'usage.json');
    const args = copilotPromptArgs(`Workflow task mode: ${step.agent}. Return the result as text.\n\n${prompt}`);
    const env = { ...process.env };
    for (const key of ['DATABASE_URL', 'ARC_POSTGRES_ADMIN_PASSWORD', 'ARC_POSTGRES_APP_PASSWORD']) delete env[key];
    const result = await spawnMonitored(
      [...command, ...args, '--model', MODEL_IDS[tier], '--usage-output-file', usageFile],
      { memoryMB, cpuWarnPercent }, { ...(signal ? { signal } : {}), env },
    );
    signal?.throwIfAborted();
    if (result.exitCode !== 0) {
      throw new Error(result.alerts.find(alert => alert.message.startsWith('🛑'))?.message
        ?? `Copilot exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 2048)}`);
    }
    const output = result.output.trim();
    if (!output) throw new Error('Copilot returned an empty response');
    const usage = await readFile(usageFile, 'utf8').then((data): unknown => JSON.parse(data)).catch(() => undefined);
    const metrics = usage && typeof usage === 'object' && 'modelMetrics' in usage ? usage.modelMetrics : undefined;
    const reportedModels = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? Object.keys(metrics) : [];
    const copilotUsage: NonNullable<StepResult['copilotUsage']> = {};
    if (usage && typeof usage === 'object') {
      for (const key of ['totalPremiumRequestCost', 'totalNanoAiu'] as const) {
        const value = (usage as Record<string, unknown>)[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) copilotUsage[key] = value;
      }
    }
    return { output, reportedModels, copilotUsage: Object.keys(copilotUsage).length ? copilotUsage : undefined };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Parse the text response into structured data when it contains JSON
 * Handles different output formats (JSON, shell scripts, plain text)
 *
 * @param output - The raw output from gh copilot
 * @returns Parsed output object, or the original string if not JSON
 */
function parseGhCopilotOutput(output: string): unknown {
  if (/^```json(?:\s|$)/i.test(output)) {
    const fenced = output.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!fenced) throw new Error('Malformed fenced JSON response');
    return JSON.parse(fenced[1]!);
  }
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function writeOutputArtifact(runDir: string, filePath: string, output: string): Promise<void> {
  const runRoot = await realpath(runDir);
  const outputRoot = join(runRoot, 'outputs');
  if (await realpath(outputRoot) !== outputRoot) throw new Error('Output directory must not be a symbolic link');
  const destination = relative(outputRoot, resolve(outputRoot, filePath));
  if (isAbsolute(filePath) || !destination || destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination)) {
    throw new Error('Output path must stay inside the run output directory');
  }

  const segments = destination.split(sep);
  const filename = segments.pop()!;
  let parent = outputRoot;
  for (const segment of segments) {
    parent = join(parent, segment);
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) throw new Error('Output directory must not be a symbolic link');
  }
  const temporary = await mkdtemp(join(parent, '.arc-output-'));
  try {
    const artifact = join(temporary, 'artifact');
    await writeFile(artifact, output, { flag: 'wx' });
    // Replace the destination entry itself rather than opening an existing symlink.
    await rename(artifact, join(parent, filename));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Save a step's output to the filesystem with Layer 8 enrichment
 * Handles different output configurations (variable, file, files)
 * Layer 8: Includes tool metadata, resource configuration, and availability in audit trail
 *
 * @param context - The execution context
 * @param step - The workflow step
 * @param output - The raw output string
 */
export async function saveStepOutputToFilesystem(
  context: ExecutionContext,
  step: WorkflowStep,
  output: string
): Promise<void> {
  const runDir = getRunDirectory(context.runId);

  // Layer 8: Build metadata enrichment for audit trail
  const auditMetadata = {
    stepId: step.id,
    timestamp: new Date().toISOString(),
    toolMetadata: null as ToolDescriptor | null,
    resourcesApplied: null as Record<string, unknown> | null,
  };

  // Layer 8: Capture tool metadata if available
  if (context.toolMetadata && context.toolMetadata.size > 0) {
    // Try to find tool that matches this step's prompt
    for (const [_toolId, toolMeta] of context.toolMetadata) {
      const toolMetaTyped = toolMeta as ToolDescriptor;
      if (
        step.prompt.includes(toolMetaTyped.id) ||
        step.prompt.includes(toolMetaTyped.name) ||
        step.prompt.toLowerCase().includes(toolMetaTyped.name.toLowerCase())
      ) {
        auditMetadata.toolMetadata = toolMetaTyped;
        break;
      }
    }
  }

  // Layer 8: Record applied resource limits
  if (step.resources) {
    auditMetadata.resourcesApplied = {
      memoryMB: step.resources.memoryMB,
      cpuWarnPercent: step.resources.cpuWarnPercent,
    };
  }

  if (step.output.type === 'file') {
    const filePath = step.output.path!;
    // Layer 8: Prepend audit metadata as JSON header
    const auditOutput = `${JSON.stringify(auditMetadata, null, 2)}\n\n---OUTPUT---\n\n${output}`;
    await writeOutputArtifact(runDir, filePath, auditOutput);
  } else if (step.output.type === 'files') {
    // For glob patterns, assume output is a list of file paths or contents
    // Implementation depends on specific use case
    // For now, save as a manifest
    const manifestPath = `${encodeURIComponent(step.id)}_manifest.json`;
    
    // Layer 8: Include tool and resource metadata in manifest
    const manifest = {
      output,
      ...auditMetadata,
    };
    await writeOutputArtifact(runDir, manifestPath, JSON.stringify(manifest, null, 2));
  }
}

/**
 * Execute a single workflow step
 * Resolves variables in the prompt, invokes gh copilot, and records the result
 *
 * @param context - The execution context
 * @param step - The workflow step to execute
 * @param attemptNumber - The current attempt number (for retries)
 * @returns The step execution result
 */
export async function executeStep(
  context: ExecutionContext,
  step: WorkflowStep,
  attemptNumber: number = 1,
  spinnerManager?: SpinnerManager,
  signal?: AbortSignal,
  command?: readonly string[],
  persistFiles = true,
): Promise<StepResult> {
  const startTime = Date.now();

  try {
    // Update context to track current step
    context.currentStepId = step.id;

    // Start spinner if manager provided
    if (spinnerManager) {
      spinnerManager.start(step.id, step.agent);
    }

    // Step 1: Resolve variable references in the prompt
    let resolvedPrompt = step.prompt;
    try {
      resolvedPrompt = resolvePrompt(step.prompt, context);
    } catch (error) {
      if (spinnerManager) {
        spinnerManager.fail(error instanceof Error ? error.message : String(error));
      }
      throw new StepExecutionError(
        `Variable resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        step.id,
        attemptNumber
      );
    }

    // Step 2: Invoke gh copilot with the resolved prompt
    // Determine resource limits (step-level override or workflow default)
    const memoryMB = step.resources?.memoryMB ?? context.config.resources?.defaultMemoryMB ?? 512;
    const cpuWarnPercent =
      step.resources?.cpuWarnPercent ?? context.config.resources?.defaultCpuWarnPercent ?? 80;

    // Step 2a: Select optimal model based on complexity
    const selectedModel = selectModel(resolvedPrompt, step.agent, step.model);

    let output: string;
    let reportedModels: string[];
    let copilotUsage: StepResult['copilotUsage'];
    try {
      ({ output, reportedModels, copilotUsage } = await invokeGhCopilot(
        resolvedPrompt, step, memoryMB, cpuWarnPercent, selectedModel, signal, command,
      ));
      spinnerManager?.update(`${output.length} characters generated`);
    } catch (error) {
      if (spinnerManager) {
        spinnerManager.fail(error instanceof Error ? error.message : String(error));
      }
      throw new StepExecutionError(
        `Agent invocation failed: ${error instanceof Error ? error.message : String(error)}`,
        step.id,
        attemptNumber
      );
    }

    // Step 3: Parse the output
    const parsedOutput = parseGhCopilotOutput(output);

    // Step 4: Save the output to storage
    signal?.throwIfAborted();
    if (persistFiles) await saveStepOutputToFilesystem(context, step, output);

    // Step 5: Create and return successful result
    const duration = Date.now() - startTime;

    // Update spinner with success
    if (spinnerManager) {
      spinnerManager.succeed(`Completed in ${(duration / 1000).toFixed(1)}s`);
    }

    // Calculate token estimate for this step
    const promptTokens = estimateTokenCount(resolvedPrompt);
    const outputTokens = estimateTokenCount(output);
    const tokenEstimate = promptTokens + outputTokens;

    return {
      stepId: step.id,
      success: true,
      output,
      parsedOutput,
      duration,
      timestamp: new Date(),
      retriesAttempted: attemptNumber - 1,
      requestedModelTier: selectedModel,
      reportedModels,
      ...(copilotUsage ? { copilotUsage } : {}),
      tokenEstimate,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    const errorMessage =
      error instanceof StepExecutionError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    // Update spinner with failure
    if (spinnerManager) {
      spinnerManager.fail(errorMessage);
    }

    return {
      stepId: step.id,
      success: false,
      output: '',
      error: errorMessage,
      duration,
      timestamp: new Date(),
      retriesAttempted: attemptNumber - 1,
    };
  }
}

/**
 * Execute a step with retry logic
 * Retries the step up to maxRetries times if it fails
 *
 * @param context - The execution context
 * @param step - The workflow step to execute
 * @param maxRetries - Maximum number of retries (from config or step)
 * @param spinnerManager - Optional spinner for visual feedback
 * @returns The step execution result (final attempt)
 */
export async function executeStepWithRetry(
  context: ExecutionContext,
  step: WorkflowStep,
  maxRetries?: number,
  spinnerManager?: SpinnerManager,
  signal?: AbortSignal,
  command?: readonly string[],
  persistFiles = true,
): Promise<StepResult> {
  const retries = maxRetries ?? step.retries ?? context.config.retries;

  let lastResult: StepResult | null = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    lastResult = await executeStep(context, step, attempt, spinnerManager, signal, command, persistFiles);

    if (signal?.aborted || lastResult.success) {
      return lastResult;
    }

    // Don't sleep on the final attempt
    if (attempt <= retries) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff
      try { await delay(delayMs, undefined, signal ? { signal } : {}); } catch { return lastResult; }
    }
  }

  if (!lastResult) throw new Error('Invalid retry count');
  return lastResult;
}

/**
 * Execute a step with timeout enforcement
 * Times out the step execution after the specified duration
 *
 * @param context - The execution context
 * @param step - The workflow step to execute
 * @param timeoutMs - Timeout in milliseconds (from step or config)
 * @param spinnerManager - Optional spinner for visual feedback
 * @returns The step execution result
 */
export async function executeStepWithTimeout(
  context: ExecutionContext,
  step: WorkflowStep,
  timeoutMs?: number,
  spinnerManager?: SpinnerManager,
  signal?: AbortSignal,
  command?: readonly string[],
  persistFiles = true,
): Promise<StepResult> {
  const timeout = timeoutMs ?? step.timeout ?? context.config.timeout;

  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason ?? new Error('Execution cancelled'));
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Step execution timed out after ${timeout}ms`)), timeout);
  try {
    return await executeStepWithRetry(context, step, undefined, spinnerManager, controller.signal, command, persistFiles);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
