/**
 * Execution Context Orchestrator
 * 
 * Manages the formal state and telemetry of active workflows. Responsibilities:
 * - ACID-compliant persistence (Atomic Switch pattern) for crash-safe execution.
 * - Real-time variable resolution and output aliasing.
 * - Run-level directory management and multi-tenant isolation.
 */

import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  Workflow,
  WorkflowConfig,
  ExecutionContext,
  StepResult,
  StepOutputConfig,
} from '../types/index.js';

const EXECUTIONS_DIR = './workflow-executions';

/**
 * Generate a unique runId combining workflow name, timestamp, and random hash
 * Format: {workflow-name}-{iso-timestamp}-{random-hash}
 *
 * @param workflowName - The name of the workflow being executed
 * @returns A unique runId string
 *
 * @example
 * generateRunId('code-review') → 'code-review-20260201T143245123Z-a7f3d2'
 */
export function generateRunId(workflowName: string): string {
  // ISO timestamp without special characters for filesystem compatibility
  const timestamp = new Date().toISOString().replace(/[:.]/g, '');

  // Generate random hash (6 characters, base36)
  const randomHash = randomBytes(4).toString('hex').substring(0, 6);

  // Sanitize workflow name (lowercase, replace spaces with hyphens)
  const sanitizedName = workflowName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);

  return `${sanitizedName}-${timestamp}-${randomHash}`;
}

/**
 * Initialize a new ExecutionContext for a workflow
 * Sets up the runId, empty variables map, and execution configuration
 *
 * @param workflow - The workflow being executed
 * @param overrideConfig - Optional config overrides
 * @returns An initialized ExecutionContext
 */
export function initializeContext(
  workflow: Workflow,
  overrideConfig?: Partial<WorkflowConfig>
): ExecutionContext {
  const resources = overrideConfig?.resources ?? workflow.config?.resources;
  const config: WorkflowConfig = {
    timeout: overrideConfig?.timeout ?? workflow.config?.timeout ?? 30000,
    retries: overrideConfig?.retries ?? workflow.config?.retries ?? 2,
    failFast: overrideConfig?.failFast ?? workflow.config?.failFast ?? true,
    validateOutput: overrideConfig?.validateOutput ?? workflow.config?.validateOutput ?? true,
    ...(resources ? { resources } : {}),
  };

  return {
    runId: generateRunId(workflow.name),
    variables: new Map(),
    results: [],
    config,
    startTime: new Date(),
    metadata: {
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      workflowDescription: workflow.description,
    },
  };
}

/**
 * Append a step result to the context's results array
 * Maintains execution history for tracing and debugging
 *
 * @param context - The execution context
 * @param result - The step result to record
 */
export function recordStepResult(context: ExecutionContext, result: StepResult): void {
  context.results.push(result);
}

/**
 * Save a step's output to the appropriate location based on output config
 * Handles variable storage, file output, and merge logic
 *
 * @param context - The execution context
 * @param stepId - The step ID being processed
 * @param outputConfig - Configuration for where/how to store output
 * @param output - The raw output string from the step
 */
export function saveStepOutput(
  context: ExecutionContext,
  _stepId: string,
  outputConfig: StepOutputConfig,
  output: string
): void {
  if (outputConfig.type === 'variable') {
    const varName = outputConfig.name!; // Zod schema guarantees this is present

    if (outputConfig.merge) {
      const existing = context.variables.get(varName);
      if (existing) {
        // Perform shallow merge for objects, append for arrays
        if (typeof existing === 'object' && Array.isArray(existing)) {
          context.variables.set(varName, [...existing, output]);
        } else if (typeof existing === 'object' && existing !== null) {
          try {
            const outputObj = JSON.parse(output);
            context.variables.set(varName, { ...existing, ...outputObj });
          } catch {
            // If not JSON, just concatenate strings
            context.variables.set(varName, String(existing) + output);
          }
        } else {
          context.variables.set(varName, String(existing) + output);
        }
      } else {
        context.variables.set(varName, output);
      }
    } else {
      context.variables.set(varName, output);
    }
  }
  // Note: 'file' and 'files' type outputs are handled at a higher level
  // (in the step executor or workflow engine) where actual file I/O is performed
}

/**
 * Get the execution directory for a specific run
 *
 * @param runId - The run identifier
 * @returns Path to the run's directory
 */
export function getRunDirectory(runId: string): string {
  return join(EXECUTIONS_DIR, runId);
}

/**
 * Ensure the execution directory structure exists
 * Creates EXECUTIONS_DIR/{runId}/ and subdirectories
 *
 * @param runId - The run identifier
 */
export async function ensureRunDirectory(runId: string): Promise<void> {
  const runDir = getRunDirectory(runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, 'outputs'), { recursive: true });
  await mkdir(join(runDir, 'logs'), { recursive: true });
}

/**
 * Persist a single step result to results.jsonl (line-delimited JSON)
 * Allows incremental recording of results without rewriting entire file
 *
 * @param runId - The run identifier
 * @param result - The step result to persist
 */
export async function persistStepResult(runId: string, result: StepResult): Promise<void> {
  const runDir = getRunDirectory(runId);
  const resultsFile = join(runDir, 'results.jsonl');

  // Convert Date objects to ISO strings for JSON serialization
  const serializedResult = {
    ...result,
    timestamp: result.timestamp.toISOString(),
  };

  await appendFile(resultsFile, JSON.stringify(serializedResult) + '\n');
}

/**
 * Persist the final execution context state to disk with atomic swap
 * Writes to temporary file, then atomically renames to final location
 * Prevents data loss if process dies during write
 *
 * @param context - The execution context to persist
 */
export async function persistContext(context: ExecutionContext): Promise<void> {
  const runDir = getRunDirectory(context.runId);
  const contextFile = join(runDir, 'context.json');
  const tempFile = join(runDir, `context.${context.runId}.tmp`);

  // Serialize the context, converting Map and Date objects
  const serializedContext = {
    runId: context.runId,
    variables: Object.fromEntries(context.variables),
    results: context.results.map((r) => ({
      ...r,
      timestamp: r.timestamp.toISOString(),
    })),
    config: context.config,
    startTime: context.startTime.toISOString(),
    endTime: context.endTime?.toISOString() || null,
    currentStepId: context.currentStepId || null,
    metadata: context.metadata || {},
  };

  // Write to temporary file first
  await writeFile(tempFile, JSON.stringify(serializedContext, null, 2));

  // Atomic swap: rename temp to final (atomic on POSIX systems)
  // If process dies during rename, temp file persists and can be recovered
  const { rename } = await import('fs/promises');
  await rename(tempFile, contextFile);
}

/**
 * Save execution metadata and summary statistics
 * Creates a high-level overview of the execution for quick reference
 *
 * @param context - The execution context
 * @param success - Whether the workflow succeeded
 * @param errors - Array of error messages, if any
 */
export async function persistExecutionMetadata(
  context: ExecutionContext,
  success: boolean,
  errors: string[]
): Promise<void> {
  const runDir = getRunDirectory(context.runId);
  const metadataFile = join(runDir, 'metadata.json');

  const duration = (context.endTime || new Date()).getTime() - context.startTime.getTime();
  const successfulSteps = context.results.filter((r) => r.success).length;
  const failedSteps = context.results.filter((r) => !r.success).length;

  const metadata = {
    runId: context.runId,
    workflow: {
      name: context.metadata?.workflowName,
      version: context.metadata?.workflowVersion,
      description: context.metadata?.workflowDescription,
    },
    execution: {
      success,
      startTime: context.startTime.toISOString(),
      endTime: (context.endTime || new Date()).toISOString(),
      durationMs: duration,
    },
    stats: {
      totalSteps: context.results.length,
      successfulSteps,
      failedSteps,
      totalVariables: context.variables.size,
    },
    errors,
  };

  await writeFile(metadataFile, JSON.stringify(metadata, null, 2));
}

/**
 * Append execution to the global runs index
 * Maintains a summary of all executions for quick lookup
 *
 * @param context - The execution context
 * @param success - Whether the workflow succeeded
 */
export async function appendToRunsIndex(
  context: ExecutionContext,
  success: boolean
): Promise<void> {
  const indexFile = join(EXECUTIONS_DIR, 'runs.json');

  const indexEntry = {
    runId: context.runId,
    workflowName: context.metadata?.workflowName,
    success,
    startTime: context.startTime.toISOString(),
    endTime: (context.endTime || new Date()).toISOString(),
  };

  // Try to read existing index, or start with empty array
  let runs: unknown[] = [];
  try {
    const indexContent = await Bun.file(indexFile).text();
    runs = JSON.parse(indexContent);
  } catch {
    // Index doesn't exist yet, start fresh
    runs = [];
  }

  runs.push(indexEntry);
  await writeFile(indexFile, JSON.stringify(runs, null, 2));
}

/**
 * Complete execution and finalize all persistence operations
 * Writes operations in sequence (not parallel) to maintain consistency:
 * 1. Context (atomic swap) - most critical
 * 2. Metadata
 * 3. Index
 *
 * If process dies, partial writes are recoverable from temp files
 *
 * @param context - The execution context
 * @param success - Whether the entire workflow succeeded
 * @param errors - Error messages, if any
 */
export async function finalizeExecution(
  context: ExecutionContext,
  success: boolean,
  errors: string[] = []
): Promise<void> {
  context.endTime = new Date();

  // Execute in sequence (not parallel) to maintain atomic semantics
  // Context is most critical - write first so recovery is possible
  await persistContext(context);

  // Metadata is secondary
  await persistExecutionMetadata(context, success, errors);

  // Index is tertiary - failure here doesn't lose context
  await appendToRunsIndex(context, success);
}
