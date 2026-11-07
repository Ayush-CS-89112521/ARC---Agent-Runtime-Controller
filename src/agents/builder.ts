import { randomUUID } from 'node:crypto';
import { ExecutableRegistry } from '../tools/executable-registry.js';
import { BuilderWorkflowSchema } from '../schemas/builder-workflow.schema.js';
import { maskGenericSecrets } from '../safety/secret-masker.js';
import type { Workflow, WorkflowStep } from '../parsers/plan-converter';

/**
 * Execution context maintained across workflow steps
 * Allows steps to reference outputs from previous steps
 */
export interface BuilderExecutionOptions {
  signal?: AbortSignal;
  permissions?: ReadonlySet<string>;
  approved?: boolean;
  executionId?: string;
}

interface ExecutionContext {
  controller: AbortController;
  activeTool: AbortController | null;
  activeStep: string | null;
  options: BuilderExecutionOptions;
  input: unknown;
  steering: Map<string, { action: string; modified_prompt?: string; context?: string }>;
  variables: Map<string, unknown>;
  stepResults: Map<string, StepResult>;
  auditTrail: AuditEntry[];
  startTime: number;
  timeoutMs: number;
}

/**
 * Result from executing a single step
 */
export interface StepResult {
  step_id: string;
  step_name: string;
  tool_id: string;
  tool_name: string;
  status: 'success' | 'failed' | 'skipped';
  output?: unknown;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  duration_ms: number;
  timestamp: string;
  prompt_executed: string;
  audit_entry_id: string;
}

/**
 * Complete workflow execution result
 */
export interface ExecutionResult {
  workflow_id: string;
  workflow_name: string;
  status: 'success' | 'partial' | 'failed';
  steps_executed: number;
  total_steps: number;
  step_results: StepResult[];
  errors: ExecutionError[];
  audit_trail_id: string;
  execution_time_ms: number;
  summary: {
    successful_steps: number;
    failed_steps: number;
    skipped_steps: number;
  };
}

/**
 * Error encountered during execution
 */
export interface ExecutionError {
  step_id: string;
  step_name: string;
  message: string;
  timestamp: string;
  recoverable: boolean;
}

/**
 * Audit trail entry for Phase 5 steering + Phase 7 RLHF
 */
export interface AuditEntry {
  id: string;
  timestamp: string;
  step_id: string;
  step_name: string;
  event_type: 'step_started' | 'step_completed' | 'tool_loaded' | 'error' | 'steering_input';
  details: unknown;
  user_input?: {
    action: 'approve' | 'modify' | 'skip' | 'terminate';
    context?: string;
    modified_prompt?: string;
  };
}

/**
 * Tool implementation interface (stub for actual tool execution)
 */
interface ToolImplementation {
  id: string;
  name: string;
  execute: (prompt: string, context: ExecutionContext) => Promise<unknown>;
}

/**
 * Builder Agent: Execute approved workflows with full tool access
 * - Loads tools from approved Workflow specification
 * - Executes in dependency order
 * - Real-time audit trail for Phase 5 steering
 * - Training data collection for Phase 7 RLHF
 */
export class BuilderAgent {
  private loadedTools: Map<string, ToolImplementation> = new Map();
  private toolCatalog: Map<string, unknown>;
  private auditTrail: AuditEntry[] = [];
  private runs = new Map<string, ExecutionContext>();
  private pending = new Map<string, { action: string; modified_prompt?: string; context?: string }>();
  private hasExecuted = false;
  private auditByRun = new Map<string, AuditEntry[]>();
  private registry: ExecutableRegistry | undefined;

  constructor(toolCatalog?: Map<string, unknown> | ExecutableRegistry) {
    this.registry = toolCatalog instanceof ExecutableRegistry ? toolCatalog : undefined;
    this.toolCatalog = toolCatalog instanceof Map ? toolCatalog : new Map();
  }

  /**
   * Main entry point: Execute a complete workflow
   */
  async execute(workflow: Workflow, options: BuilderExecutionOptions = {}): Promise<ExecutionResult> {
    BuilderWorkflowSchema.parse(workflow);
    const startTime = Date.now();
    const executionId = options.executionId ?? randomUUID();
    if (this.runs.has(executionId)) throw new Error('Execution ID is already active');
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason ?? new Error('Execution cancelled'));
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const context: ExecutionContext = {
      controller, activeTool: null, activeStep: null, options: { ...options, executionId }, input: undefined, steering: new Map(this.pending),
      variables: new Map(),
      stepResults: new Map(),
      auditTrail: [],
      startTime,
      timeoutMs: 300000, // 5-minute default timeout
    };

    const stepResults: StepResult[] = [];
    const errors: ExecutionError[] = [];
    let executedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Build execution order based on dependencies
    let executionOrder: number[];
    try { executionOrder = this.buildExecutionOrder(workflow.steps); }
    catch (error) { options.signal?.removeEventListener('abort', abort); throw error; }
    this.pending.clear();
    this.runs.set(executionId, context);
    this.hasExecuted = true;

    // Execute steps in order
    for (const stepIndex of executionOrder) {
      if (controller.signal.aborted) break;
      let step = workflow.steps[stepIndex];
      const intervention = context.steering.get(step.id);
      if (intervention?.modified_prompt) step = { ...step, prompt: intervention.modified_prompt };
      if (intervention?.context) step = { ...step, prompt: `${step.prompt}\nUser context: ${intervention.context}` };

      try {
        // Check dependencies before executing
        if (intervention?.action === 'skip' || !this.evaluateConditions(step, context)) {
          // Step skipped due to unmet conditions
          const skipResult = this.createSkippedResult(step);
          stepResults.push(skipResult);
          context.stepResults.set(step.id, skipResult);
          skippedCount++;
          continue;
        }

        // Execute the step
        context.activeStep = step.id;
        let result = await this.executeStep(step, context);
        context.activeStep = null;
        if (context.steering.get(step.id)?.action === 'skip') {
          result = this.createSkippedResult(step);
          skippedCount++;
          stepResults.push(result);
          context.stepResults.set(step.id, result);
          continue;
        }
        stepResults.push(result);
        context.stepResults.set(step.id, result);
        executedCount++;

        if (result.status === 'failed') {
          failedCount++;
          errors.push({
            step_id: step.id,
            step_name: step.name,
            message: result.error?.message || 'Unknown error',
            timestamp: new Date().toISOString(),
            recoverable: this.isRecoverable(step, result),
          });

          // Handle error according to strategy
          if (step.error_handling?.on_failure === 'stop_workflow') {
            break;
          }
        }
      } catch (err) {
        executedCount++;
        failedCount++;
        const errorMsg =
          maskGenericSecrets(err instanceof Error ? err.message : String(err)).masked;
        errors.push({
          step_id: step.id,
          step_name: step.name,
          message: errorMsg,
          timestamp: new Date().toISOString(),
          recoverable: false,
        });

        if (step.error_handling?.on_failure === 'stop_workflow') {
          break;
        }
      }
    }

    this.runs.delete(executionId);
    options.signal?.removeEventListener('abort', abort);
    if (controller.signal.aborted && errors.length === 0) errors.push({ step_id: 'controller', step_name: 'controller', message: 'Execution cancelled', timestamp: new Date().toISOString(), recoverable: false });
    const endTime = Date.now();

    // Copy audit trail to class property so getAuditTrail() can access it
    this.auditTrail = context.auditTrail;
    this.auditByRun.set(executionId, context.auditTrail);
    if (this.auditByRun.size > 100) {
      const oldest = this.auditByRun.keys().next().value;
      if (oldest !== undefined) this.auditByRun.delete(oldest);
    }

    return {
      workflow_id: workflow.name,
      workflow_name: workflow.name,
      status:
        controller.signal.aborted ? 'failed' : failedCount === 0
          ? 'success'
          : failedCount === executedCount
            ? 'failed'
            : 'partial',
      steps_executed: executedCount,
      total_steps: workflow.steps.length,
      step_results: stepResults,
      errors,
      audit_trail_id: executionId,
      execution_time_ms: endTime - startTime,
      summary: {
        successful_steps: executedCount - failedCount,
        failed_steps: failedCount,
        skipped_steps: skippedCount,
      },
    };
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: WorkflowStep,
    context: ExecutionContext,
  ): Promise<StepResult> {
    const stepStartTime = Date.now();
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Log step started
    context.auditTrail.push({
      id: auditId,
      timestamp: new Date().toISOString(),
      step_id: step.id,
      step_name: step.name,
      event_type: 'step_started',
      details: {
        tool_id: step.tools[0]?.id,
        prompt_hash: this.hashString(step.prompt),
      },
    });

    try {
      // Load tool
      if (step.tools.length !== 1) throw new Error('Each Builder step must request exactly one tool');
      context.input = step.input ?? { prompt: step.prompt };
      const registry = this.registry;
      const tool = registry ? {
        id: step.tools[0].id, name: step.tools[0].name,
        execute: async (_prompt: string, current: ExecutionContext) => registry.invoke(step.tools[0].id, current.input, {
          permissions: current.options.permissions ?? new Set(), approved: current.options.approved === true || current.steering.get(step.id)?.action === 'approve',
          operationId: JSON.stringify([current.options.executionId, step.id]),
          signal: current.activeTool?.signal ?? current.controller.signal,
          timeoutMs: step.safety?.timeout ?? 60000,
        }),
      } : await this.loadTool(step.tools[0].id);
      if (!tool) {
        throw new Error(`Failed to load tool: ${step.tools[0]?.id}`);
      }
      if (!registry) {
        if (!context.options.permissions?.has(`tool:${tool.id}`)) throw new Error(`Permission denied: tool:${tool.id}`);
        if (step.safety.require_approval && !context.options.approved && context.steering.get(step.id)?.action !== 'approve') {
          throw new Error(`Approval required: ${tool.id}`);
        }
      }

      context.auditTrail.push({
        id: `audit_${Date.now()}_load`,
        timestamp: new Date().toISOString(),
        step_id: step.id,
        step_name: step.name,
        event_type: 'tool_loaded',
        details: {
          tool_id: tool.id,
          tool_name: tool.name,
        },
      });

      // Execute tool with step prompt
      const output = await this.runTool(
        tool,
        step.prompt,
        context,
        step.safety?.timeout || 60000,
      );

      const stepEndTime = Date.now();

      context.auditTrail.push({
        id: auditId + '_complete',
        timestamp: new Date().toISOString(),
        step_id: step.id,
        step_name: step.name,
        event_type: 'step_completed',
        details: {
          output_size: JSON.stringify(output).length,
          duration_ms: stepEndTime - stepStartTime,
        },
      });

      // Store result in context for dependent steps
      const result: StepResult = {
        step_id: step.id,
        step_name: step.name,
        tool_id: tool.id,
        tool_name: tool.name,
        status: 'success',
        output,
        duration_ms: stepEndTime - stepStartTime,
        timestamp: new Date().toISOString(),
        prompt_executed: step.prompt,
        audit_entry_id: auditId,
      };

      return result;
    } catch (err) {
      const stepEndTime = Date.now();
      const errorMsg =
        maskGenericSecrets(err instanceof Error ? err.message : String(err)).masked;

      context.auditTrail.push({
        id: auditId + '_error',
        timestamp: new Date().toISOString(),
        step_id: step.id,
        step_name: step.name,
        event_type: 'error',
        details: {
          error_message: errorMsg,
          error_type: err instanceof Error ? err.constructor.name : 'Unknown',
        },
      });

      return {
        step_id: step.id,
        step_name: step.name,
        tool_id: step.tools[0]?.id || 'unknown',
        tool_name: step.tools[0]?.name || 'Unknown',
        status: 'failed',
        error: {
          message: errorMsg,
          code: 'EXECUTION_ERROR',
          ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
        },
        duration_ms: stepEndTime - stepStartTime,
        timestamp: new Date().toISOString(),
        prompt_executed: step.prompt,
        audit_entry_id: auditId,
      };
    }
  }

  /**
   * Load tool dynamically from catalog
   * Only loads tools that are explicitly in the approved Workflow
   */
  private async loadTool(toolId: string): Promise<ToolImplementation | null> {
    // Check cache first
    if (this.loadedTools.has(toolId)) {
      return this.loadedTools.get(toolId) || null;
    }

    const tool = this.toolCatalog.get(toolId) as ToolImplementation | undefined;
    if (!tool || typeof tool.execute !== 'function') {
      throw new Error(`Tool '${toolId}' is not registered with an executable implementation`);
    }
    this.loadedTools.set(toolId, tool);
    return tool;
  }

  /**
   * Run tool with timeout and error handling
   */
  private async runTool(
    tool: ToolImplementation,
    prompt: string,
    context: ExecutionContext,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    context.activeTool = controller;
    const cancel = () => controller.abort(context.controller.signal.reason ?? new Error('Execution cancelled'));
    context.controller.signal.addEventListener('abort', cancel, { once: true });
    if (context.controller.signal.aborted) cancel();
    const timer = setTimeout(() => context.controller.abort(new Error(`Tool execution timeout after ${timeoutMs}ms`)), timeoutMs);
    let listener: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const abort = new Promise<never>((_, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      const result = await Promise.race([tool.execute(prompt, context), abort]);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      context.controller.signal.removeEventListener('abort', cancel);
      if (listener) controller.signal.removeEventListener('abort', listener);
      context.activeTool = null;
    }
  }

  /**
   * Evaluate conditional execution (when clauses)
   * Returns true if step should execute, false if conditions not met
   */
  private evaluateConditions(
    step: WorkflowStep,
    context: ExecutionContext,
  ): boolean {
    if (!step.when) {
      return true; // No conditions, execute
    }

    // Parse "step_X_complete == true && step_Y_complete == true"
    const conditions = step.when.split('&&').map(c => c.trim());

    for (const condition of conditions) {
      const match = condition.match(/^step_(\d+)_complete\s*==\s*true$/);
      if (!match) throw new Error(`Invalid Builder condition: ${condition}`);
      if (match) {
        const depStepId = `step_${match[1]}`;
        const depResult = context.stepResults.get(depStepId);

        if (!depResult || depResult.status !== 'success') {
          return false; // Dependency not met
        }
      }
    }

    return true; // All conditions met
  }

  /**
   * Build execution order from dependency graph
   * Returns array of step indices in execution order
   */
  private buildExecutionOrder(steps: WorkflowStep[]): number[] {
    const indices = new Map(steps.map((step, index) => [step.id, index]));
    if (indices.size !== steps.length) throw new Error('Duplicate step IDs in workflow');
    const order: number[] = [];
    const visited = new Set<number>();
    const visiting = new Set<number>();

    const visit = (index: number) => {
      if (visited.has(index)) return;
      if (visiting.has(index)) {
        throw new Error('Circular dependency detected in workflow');
      }

      visiting.add(index);
      const step = steps[index];

      // Extract dependencies from when clause
      if (step.when) {
        const matches = step.when.match(/step_(\d+)_complete/g);
        if (matches) {
          const deps = [...new Set(matches)]; // Remove duplicates
          for (const dep of deps) {
            const depMatch = dep.match(/step_(\d+)/);
            if (depMatch) {
              const depId = `step_${depMatch[1]}`;
              const depIndex = indices.get(depId);
              if (depIndex === undefined) throw new Error(`Unknown dependency: ${depId}`);
              visit(depIndex);
            }
          }
        }
      }

      visiting.delete(index);
      visited.add(index);
      order.push(index);
    };

    for (let i = 0; i < steps.length; i++) {
      visit(i);
    }

    return order;
  }

  /**
   * Check if error is recoverable
   */
  private isRecoverable(
    _step: WorkflowStep,
    result: StepResult,
  ): boolean {
    // Timeouts and network errors are generally recoverable
    const message = result.error?.message || '';
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('ECONNREFUSED')
    );
  }

  /**
   * Create result for skipped step
   */
  private createSkippedResult(step: WorkflowStep): StepResult {
    return {
      step_id: step.id,
      step_name: step.name,
      tool_id: step.tools[0]?.id || 'unknown',
      tool_name: step.tools[0]?.name || 'Unknown',
      status: 'skipped',
      duration_ms: 0,
      timestamp: new Date().toISOString(),
      prompt_executed: '', // Not executed
      audit_entry_id: `skipped_${Date.now()}`,
    };
  }

  /**
   * Simple hash for audit trail
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Get audit trail for Phase 5 steering + Phase 7 RLHF
   */
  getAuditTrail(executionId?: string): AuditEntry[] {
    return structuredClone(executionId
      ? this.runs.get(executionId)?.auditTrail ?? this.auditByRun.get(executionId) ?? []
      : this.auditTrail);
  }

  /**
   * Allow Phase 5 steering to inject user feedback
   */
  async handleSteeringInput(
    stepId: string,
    input: {
      action: 'approve' | 'modify' | 'skip' | 'terminate';
      context?: string;
      modified_prompt?: string;
    },
    executionId?: string,
  ): Promise<void> {
    if (!executionId && this.runs.size > 1) throw new Error('Specify executionId for concurrent steering');
    const run = executionId ? this.runs.get(executionId) : [...this.runs.values()][0];
    if (executionId && !run) throw new Error('Execution is not active');
    if (run) {
      if (input.action === 'modify' && run.activeTool && run.activeStep === stepId) throw new Error('Cannot modify an active tool; cancel or skip first');
      run.steering.set(stepId, input);
      if (input.action === 'terminate') run.controller.abort(new Error('Execution cancelled by steering'));
      if (input.action === 'skip' && run.activeStep === stepId) run.activeTool?.abort(new Error('Step skipped by steering'));
    } else if (!this.hasExecuted) this.pending.set(stepId, input);
    (run?.auditTrail ?? this.auditTrail).push({
      id: `steering_${Date.now()}`,
      timestamp: new Date().toISOString(),
      step_id: stepId,
      step_name: stepId,
      event_type: 'steering_input',
      user_input: input,
      details: {
        action: input.action,
        has_context: !!input.context,
        has_modified_prompt: !!input.modified_prompt,
      },
    });
  }
}
