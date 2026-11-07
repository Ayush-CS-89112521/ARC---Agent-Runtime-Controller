/**
 * Workflow Engine - Core Execution Orchestrator
 * 
 * Implements the primary execution logic for multi-step automation.
 * Features:
 * - Topological dependency resolution.
 * - ACID-compliant persistence (Atomic Switch pattern).
 * - Multi-layer safety guardrail integration.
 * - Integrated terminal UI telemetry.
 */

import {
  Workflow,
  ExecutionContext,
  ExecutionReport,
  SafetyScanResult,
} from '../types/index.js';
import {
  initializeContext,
  recordStepResult,
  saveStepOutput,
  ensureRunDirectory,
  persistStepResult,
  finalizeExecution,
} from '../context/context-manager.js';
import { executeStepWithTimeout, saveStepOutputToFilesystem } from '../execution/step-executor.js';
import { evaluateCondition } from '../execution/condition-evaluator.js';
import { SafetyGuardrail, SafetyViolationError } from '../safety/safety-guardrail.js';
import {
  promptForApprovalWithInquirer,
  recordDecision,
  formatDecisionSummary,
} from '../interactive/prompt-handler.js';
import { UIManager } from '../ui/ui-manager.js';
import { ProgressHeader } from '../ui/progress-header.js';

/**
 * Error thrown when workflow execution fails
 */
export class WorkflowExecutionError extends Error {
  constructor(
    message: string,
    public readonly stepId?: string,
    public readonly context?: ExecutionContext
  ) {
    super(message);
    this.name = 'WorkflowExecutionError';
  }
}

/**
 * Configuration options for workflow execution
 */
export interface WorkflowExecutionOptions {
  signal?: AbortSignal;
  /** Trusted host override for the Copilot command prefix. */
  copilotCommand?: readonly string[];
  /** Override global timeout (ms) */
  timeout?: number;
  /** Override global retry count */
  retries?: number;
  /** Stop on first step failure */
  failFast?: boolean;
  /** Whether to validate outputs */
  validateOutput?: boolean;
}

/**
 * Primary workflow execution gateway.
 * Orchestrates the full lifecycle of a multi-step workflow including:
 * - State initialization and ACID-compliant persistence.
 * - Resource monitoring and safety guardrail enforcement.
 * - Real-time UI telemetry and error recovery.
 * 
 * @param workflow - The validated workflow structure to execute.
 * @param options - Runtime execution overrides (timeout, etc).
 * @returns Comprehensive execution report with results and final context.
 */
export async function executeWorkflow(
  workflow: Workflow,
  options?: WorkflowExecutionOptions
): Promise<ExecutionReport> {
  // Initialize execution context
  const context = initializeContext(workflow, options);

  const errors: string[] = [];
  const safetyScans: SafetyScanResult[] = [];

  // Initialize UI components
  const ui = UIManager.getInstance();
  const progressHeader = new ProgressHeader(workflow.steps.length, ui.getConfig().showProgress);
  const spinnerManager = ui.getSpinnerManager();

  // Initialize safety guardrail (workflow-level policy)
  const workflowSafetyPolicy = workflow.config?.safety;
  const guardrail = new SafetyGuardrail(workflowSafetyPolicy);

  // Ensure execution directory exists
  try {
    await ensureRunDirectory(context.runId);
  } catch (error) {
    const errorMsg = `Failed to create execution directory: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(errorMsg);

    return {
      workflow,
      context,
      success: false,
      errors,
      totalDuration: Date.now() - context.startTime.getTime(),
      stats: {
        totalSteps: workflow.steps.length,
        successfulSteps: 0,
        failedSteps: 0,
      },
      safetyScans,
    };
  }

  // Execute each step in sequence
  let stepNumber = 0;
  const completedSteps: string[] = [];
  const skippedStepsArray: string[] = [];

  for (const step of workflow.steps) {
    if (options?.signal?.aborted) { errors.push('Workflow cancelled'); break; }
    stepNumber++;
    try {
      // Update progress header
      progressHeader.update(stepNumber, step.id, completedSteps, skippedStepsArray);

      // PHASE 1: Evaluate conditional expression (if present)
      if (step.when) {
        const conditionResult = evaluateCondition(step.when, context);

        if (conditionResult.error) {
          errors.push(`Step '${step.id}' condition error: ${conditionResult.error}`);
          if (context.config.failFast) {
            break;
          }
          continue;
        }

        // If condition evaluates to false, skip this step
        if (!conditionResult.evaluated) {
          const reason = `Condition "${step.when}" evaluated to false`;
          console.log(`⏭️  Skipping step '${step.id}': ${reason}`);

          // Record skip for audit trail
          if (!context.skippedSteps) {
            context.skippedSteps = [];
          }
          context.skippedSteps.push({
            stepId: step.id,
            condition: step.when,
            timestamp: new Date(),
            reason,
          });

          skippedStepsArray.push(step.id);
          if (spinnerManager) {
            spinnerManager.skip(reason);
          }
          continue; // Skip to next step
        }
      }

      // Apply step-level safety policy override if present
      if (step.safety) {
        guardrail.mergePolicy(step.safety);
      }

      // Execute the step with timeout and pass spinnerManager
      const result = await executeStepWithTimeout(context, step, undefined, spinnerManager, options?.signal, options?.copilotCommand, false);

      // SAFETY INTERCEPTION POINT: Scan step output BEFORE variable persistence
      let safetyChecksPassed = true;
      try {
        const scanResult = await guardrail.scanStepOutput(step.id, result.output);
        safetyScans.push(scanResult);
        context.safetyScans = safetyScans;

        // Handle safety scan result
        if (scanResult.violations.length > 0) {
          // Check if should pause for human confirmation
          if (guardrail.shouldPause(scanResult)) {
            // Interactive approval flow for pause-level violations
            for (const violation of scanResult.violations) {
              if (violation.severity === 'pause') {
                // Use Inquirer-based prompt with enhanced UX
                const { decision } = await promptForApprovalWithInquirer(violation, step.id, result.output);

                // Record user decision in violation
                recordDecision(violation, decision);

                // Display decision summary
                console.log(formatDecisionSummary(decision, step.id, violation.category));

                // Handle decision
                if (decision === 'deny') {
                  safetyChecksPassed = false;
                  const errorMsg = `User denied safety violation in step '${step.id}': ${violation.pattern}`;
                  errors.push(errorMsg);
                  break; // Stop processing this step
                } else if (decision === 'allow') {
                  // Continue with variable persistence
                  console.log(`✅ Variable approved and will persist for next step.\n`);
                }
                // For 'inspect', user already reviewed and returned here, treat as 'allow'
              }
            }

            // If any violation was denied, fail the step
            if (!safetyChecksPassed) {
              recordStepResult(context, { ...result, output: '', parsedOutput: undefined, success: false, error: errors[errors.length - 1] });
              if (context.config.failFast) {
                break;
              }
              continue;
            }
          } else {
            // Format violations for user display (warn-level)
            const violationDisplay = guardrail.formatViolationsForDisplay(scanResult.violations);
            console.log(violationDisplay);

            // Validate scan result (throws on block-level violations)
            guardrail.validateScanResult(scanResult);
          }
        }
      } catch (safetyError) {
        if (safetyError instanceof SafetyViolationError) {
          const safetyMsg = `Safety violation in step '${step.id}': ${safetyError.message}`;
          errors.push(safetyMsg);
          safetyChecksPassed = false;
          recordStepResult(context, { ...result, output: '', parsedOutput: undefined, success: false, error: safetyMsg });

          if (context.config.failFast) {
            break;
          }
          continue;
        }
        // Re-throw other errors
        throw safetyError;
      }

      if (result.success) {
        try {
          options?.signal?.throwIfAborted();
          await saveStepOutputToFilesystem(context, step, result.output);
          completedSteps.push(step.id);
        } catch (error) {
          result.success = false;
          result.error = error instanceof Error ? error.message : String(error);
        }
      }
      recordStepResult(context, result);

      // Persist the result incrementally
      try {
        await persistStepResult(context.runId, result);
      } catch (persistError) {
        const persistMsg = `Failed to persist step result: ${persistError instanceof Error ? persistError.message : String(persistError)}`;
        errors.push(persistMsg);
      }

      // If step failed, decide whether to continue
      if (!result.success) {
        const failureMsg = `Step '${step.id}' failed: ${result.error || 'unknown error'}`;
        errors.push(failureMsg);

        if (context.config.failFast) {
          break;
        }
        continue;
      }

      // Only save step output if safety checks passed
      if (safetyChecksPassed) {
        // Save the output to context variables
        saveStepOutput(context, step.id, step.output, result.output);
      }
    } catch (error) {
      const stepError = `Step '${step.id}' execution error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(stepError);

      if (context.config.failFast) {
        break;
      }
    }
  }

  // Determine overall success
  const failedSteps = context.results.filter((r) => !r.success);
  const success = failedSteps.length === 0 && errors.length === 0 && !options?.signal?.aborted;

  // Finalize execution
  try {
    await finalizeExecution(context, success, errors);
  } catch (error) {
    const finalizeMsg = `Failed to finalize execution: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(finalizeMsg);
  }

  // Build execution report
  const totalDuration = Date.now() - context.startTime.getTime();

  return {
    workflow,
    context,
    success,
    errors,
    totalDuration,
    stats: {
      totalSteps: workflow.steps.length,
      successfulSteps: context.results.filter((r) => r.success).length,
      failedSteps: failedSteps.length,
    },
    safetyScans,
  };
}

/**
 * Execute a workflow and log the results to console
 * Useful for CLI output
 *
 * @param workflow - The workflow to execute
 * @param options - Execution options
 * @returns The execution report
 */
export async function executeWorkflowWithLogging(
  workflow: Workflow,
  options?: WorkflowExecutionOptions
): Promise<ExecutionReport> {
  console.log(`\n🚀 Starting workflow: ${workflow.name}`);
  if (workflow.description) {
    console.log(`   ${workflow.description}`);
  }
  console.log(`   Total steps: ${workflow.steps.length}\n`);

  const report = await executeWorkflow(workflow, options);

  // Log step results
  console.log('📋 Execution Results:');
  for (const result of report.context.results) {
    const icon = result.success ? '✅' : '❌';
    const duration = `${result.duration}ms`;
    console.log(`  ${icon} ${result.stepId} (${duration})`);

    if (!result.success) {
      console.log(`     Error: ${result.error}`);
    }
  }

  // Log summary
  console.log('\n📊 Summary:');
  console.log(`  Total Duration: ${report.totalDuration}ms`);
  console.log(`  Success: ${report.success ? '✅' : '❌'}`);
  console.log(`  Steps: ${report.stats.successfulSteps}/${report.stats.totalSteps} successful`);

  if (report.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    for (const error of report.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log(`\n📁 Run ID: ${report.context.runId}`);
  console.log(`   Results saved to: ./workflow-executions/${report.context.runId}/\n`);

  return report;
}

/**
 * Validate a workflow before execution
 * Performs pre-flight checks on the workflow structure
 *
 * @param workflow - The workflow to validate
 * @returns An object with validation status and any errors found
 */
export function validateWorkflowBeforeExecution(
  workflow: Workflow
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check: Workflow has at least one step
  if (workflow.steps.length === 0) {
    errors.push('Workflow must have at least one step');
  }

  // Check: All step IDs are unique
  const stepIds = new Set<string>();
  for (const step of workflow.steps) {
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: '${step.id}'`);
    }
    stepIds.add(step.id);
  }

  // Check: Agent values are supported
  const validAgents = ['suggest', 'explain', 'edit'];
  for (const step of workflow.steps) {
    if (!validAgents.includes(step.agent)) {
      errors.push(`Unsupported agent '${step.agent}' in step '${step.id}'`);
    }
  }

  // Check: Variable-type outputs have names
  for (const step of workflow.steps) {
    if (step.output.type === 'variable' && !step.output.name) {
      errors.push(`Step '${step.id}': variable-type outputs must have a 'name' field`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
