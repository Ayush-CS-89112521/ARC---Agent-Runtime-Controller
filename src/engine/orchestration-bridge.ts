/**
 * Orchestration Bridge - Adapter for Phase 6c Integration
 * Converts between BuilderAgent ExecutionResult and traditional ExecutionReport
 * Enables seamless integration between Phase 6c orchestrator and workflow engine
 *
 * Phase 2 Component: Context & Result Conversion
 */

import type { ExecutionContext, ExecutionReport, StepResult } from '../types/index.js';
import type { ExecutionResult, AuditEntry } from '../agents/builder.js';
import type { Workflow } from '../parsers/plan-converter.js';

/**
 * Orchestrator execution options passed from CLI
 */
export interface OrchestratorExecutionOptions {
  timeout?: number;
  retries?: number;
  failFast?: boolean;
  validateOutput?: boolean;
  autoApprove?: boolean;
  noSteering?: boolean;
}

/**
 * Bridge context maintaining both execution models simultaneously
 */
export interface BridgeContext {
  // Traditional workflow engine context
  workflowContext: ExecutionContext;
  
  // Orchestrator context from Phase 6
  builderResult?: ExecutionResult;
  
  // Mapping between contexts
  stepIdMapping: Map<string, string>; // builder step_id → workflow step id
  auditTrail: AuditEntry[];
  
  // Options applied
  options: OrchestratorExecutionOptions;
}

/**
 * Convert BuilderAgent ExecutionResult to traditional ExecutionReport
 * Enables Phase 6c orchestrator results to be consumed by traditional tooling
 *
 * @param workflow - The workflow that was executed
 * @param builderResult - Result from BuilderAgent.execute()
 * @param bridgeContext - Bridge context with conversion mappings
 * @returns ExecutionReport compatible with workflow-engine
 */
export function convertBuilderResultToReport(
  workflow: Workflow,
  builderResult: ExecutionResult,
  bridgeContext: BridgeContext
): ExecutionReport<Workflow> {
  // Convert builder step results to traditional format
  const stepResults: StepResult[] = builderResult.step_results.map((builderStep) => {
    // Find corresponding workflow step
    const workflowStepId = bridgeContext.stepIdMapping.get(builderStep.step_id) || builderStep.step_id;

    return {
      stepId: workflowStepId,
      success: builderStep.status === 'success',
      output: typeof builderStep.output === 'string' ? builderStep.output : (JSON.stringify(builderStep.output) ?? ''),
      duration: builderStep.duration_ms,
      timestamp: new Date(builderStep.timestamp),
      retriesAttempted: 0,
      ...(builderStep.error ? { error: builderStep.error.message } : {}),
    };
  });

  // Merge step results into execution context
  const context = bridgeContext.workflowContext;
  stepResults.forEach((result) => {
    context.results.push(result);
  });

  // Create execution report
  const report: ExecutionReport<Workflow> = {
    workflow,
    context,
    success: builderResult.status === 'success',
    errors: builderResult.errors.map((e) => `${e.step_name}: ${e.message}`),
    totalDuration: builderResult.execution_time_ms,
    stats: {
      totalSteps: builderResult.total_steps,
      successfulSteps: builderResult.summary.successful_steps,
      failedSteps: builderResult.summary.failed_steps,
    },
  };

  return report;
}

/**
 * Create step ID mapping between builder and workflow step IDs
 *
 * @param workflow - The workflow with steps
 * @returns Map of builder step_id to workflow step id
 */
export function createStepIdMapping(workflow: Workflow): Map<string, string> {
  const mapping = new Map<string, string>();

  workflow.steps.forEach((step, index) => {
    // Builder uses format: "step_0", "step_1", etc.
    const builderId = `step_${index}`;
    const workflowId = step.id || `step_${index}`;
    mapping.set(builderId, workflowId);
  });

  return mapping;
}

/**
 * Initialize bridge context for orchestrator execution
 *
 * @param workflow - The workflow being executed
 * @param options - Orchestrator options from CLI
 * @returns BridgeContext ready for execution
 */
export function initializeBridgeContext(
  workflow: Workflow,
  options: OrchestratorExecutionOptions
): BridgeContext {
  const workflowContext: ExecutionContext = {
    runId: `orch-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    variables: new Map(),
    results: [],
    config: {
      timeout: options.timeout ?? 30000,
      retries: options.retries ?? 2,
      failFast: options.failFast ?? true,
      validateOutput: options.validateOutput ?? true,
    },
    startTime: new Date(),
    metadata: {
      workflowName: workflow.name,
      workflowVersion: '6c',
      workflowDescription: `Orchestrator-generated: ${workflow.description || 'N/A'}`,
    },
  };

  return {
    workflowContext,
    stepIdMapping: createStepIdMapping(workflow),
    auditTrail: [],
    options,
  };
}

/**
 * Merge audit trail from orchestrator execution into bridge context
 *
 * @param context - Bridge context
 * @param auditTrail - Audit entries from builder
 */
export function mergeAuditTrail(context: BridgeContext, auditTrail: AuditEntry[]): void {
  context.auditTrail.push(...auditTrail);
}

/**
 * Generate summary of orchestrator execution
 *
 * @param context - Bridge context
 * @param result - Final execution result
 * @returns Human-readable summary
 */
export function generateExecutionSummary(_context: BridgeContext, result: ExecutionResult): string {
  const summary = [
    `Orchestrator Execution Summary`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Status: ${result.status.toUpperCase()}`,
    `Execution Time: ${result.execution_time_ms}ms`,
    `Total Steps: ${result.total_steps}`,
    `Successful: ${result.summary.successful_steps}`,
    `Failed: ${result.summary.failed_steps}`,
    `Skipped: ${result.summary.skipped_steps}`,
  ];

  if (result.errors.length > 0) {
    summary.push(``, `Errors:`);
    result.errors.forEach((error) => {
      summary.push(`  • ${error.step_name}: ${error.message}`);
    });
  }

  summary.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return summary.join('\n');
}
