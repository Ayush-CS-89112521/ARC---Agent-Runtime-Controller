/**
 * Auto-Switch Orchestrator: Phase 6 Hybrid Execution Engine
 * 
 * Implements the Architect-Builder design pattern, orchestrating:
 * 1. Strategic Planning (Architect Phase via gh copilot).
 * 2. Human-in-the-Loop Validation (Steering Phase).
 * 3. Contextual Tool Injection (Optimization Phase).
 * 4. High-Efficiency Execution (Builder Phase via Haiku/Sonnet).
 */

import { ArchitectPlan } from '../types/architect';
import { Workflow, WorkflowStep } from '../parsers/plan-converter';
import { ArchitectService } from '../services/architect-service';
import { PlanConverter, type HallucinationAlert } from '../parsers/plan-converter';
import { BuilderAgent, type ExecutionResult } from '../agents/builder';
import { CheckpointHandler, type CheckpointDecision } from '../interactive/checkpoint-handler';
import { ToolPruner } from '../optimization/tool-pruner';
import { ExecutableRegistry } from '../tools/executable-registry.js';
import { registerLocalTools } from '../tools/local-adapters.js';

/**
 * Planner Execution Mode: How to handle planning vs execution
 */
export enum PlannerExecutionMode {
  /** Full auto-switch: Plan → Validate → Convert → Execute */
  AUTO_SWITCH = 'auto-switch',
  /** Plan only, stop before validation */
  PLAN_ONLY = 'plan-only',
  /** Execute only (traditional mode, no planning) */
  EXECUTE_ONLY = 'execute-only',
  /** Plan and execute, but don't require steering approval */
  AUTO_EXECUTE = 'auto-execute',
  /** Traditional mode (no Phase 6) */
  TRADITIONAL = 'traditional',
}

/**
 * Configuration for planner execution orchestration
 */
export interface PlannerExecutionConfig {
  mode: PlannerExecutionMode;
  steeringEnabled: boolean;
  toolPruningEnabled: boolean;
  autoApprove: boolean;
  timeout: number; // milliseconds
  permissions: string[];
}

/**
 * State of the planner execution pipeline
 */
export interface PlannerExecutionContext {
  /** Current execution mode */
  mode: PlannerExecutionMode;
  /** Cached architect plan */
  currentPlan?: ArchitectPlan;
  /** Cached steering decision */
  currentCheckpointDecision?: CheckpointDecision;
  /** Generated workflow steps ready for execution */
  generatedSteps?: WorkflowStep[];
  /** Hallucination alerts from conversion */
  hallucinations: HallucinationAlert[];
  /** Audit trail events */
  auditTrail: PlannerAuditEntry[];
  /** Whether planning phase completed */
  planningComplete: boolean;
  /** Whether validation phase completed */
  validationComplete: boolean;
  /** Whether conversion phase completed */
  conversionComplete: boolean;
  /** Execution results from Builder */
  executionResult?: ExecutionResult;
  /** Start time for phase timing */
  startTime: Date;
}

/**
 * Audit entry for planner phases
 */
export interface PlannerAuditEntry {
  timestamp: string;
  phase: 'A_PLANNING' | 'B_VALIDATION' | 'C_CONVERSION' | 'D_EXECUTION';
  event: string;
  details?: unknown;
}

/**
 * Auto-Switch Orchestrator: Main class for Phase 6 integration
 */
export class AutoSwitchOrchestrator {
  private config: PlannerExecutionConfig;
  private executionContext: PlannerExecutionContext;
  private architectService?: ArchitectService;
  private planConverter?: PlanConverter;
  private builderAgent?: BuilderAgent;
  private checkpointHandler?: CheckpointHandler;
  private toolPruner?: ToolPruner;
  private registry: ExecutableRegistry;
  private signal: AbortSignal | undefined;
  private running = false;

  constructor(config: Partial<PlannerExecutionConfig> = {}, registry?: ExecutableRegistry) {
    this.registry = registry ?? registerLocalTools(new ExecutableRegistry(), process.cwd());
    this.config = {
      permissions: [],
      mode: PlannerExecutionMode.AUTO_SWITCH,
      steeringEnabled: true,
      toolPruningEnabled: true,
      autoApprove: false,
      timeout: 300000, // 5 minutes
      ...config,
    };

    this.executionContext = {
      mode: this.config.mode,
      hallucinations: [],
      auditTrail: [],
      planningComplete: false,
      validationComplete: false,
      conversionComplete: false,
      startTime: new Date(),
    };

    this.initializeServices();
  }

  /**
   * Initialize required services for orchestration
   */
  private initializeServices(): void {
    try {
      const catalog = this.registry.catalog();
      this.architectService = new ArchitectService({}, catalog);
      this.planConverter = new PlanConverter(catalog);
      this.builderAgent = new BuilderAgent(this.registry);

      // Initialize Checkpoint (steering gate)
      this.checkpointHandler = new CheckpointHandler({
        show_full_prompts: false,
        require_approval_for: ['auth_required', 'hallucinations'],
      });

      // Initialize Tool Pruner
      this.toolPruner = new ToolPruner({ max_relevant_tools: 20, min_relevance_score: 1, selection_strategy: 'hybrid' },
        catalog.map(tool => ({ id: tool.id, name: tool.name, description: tool.description, category: tool.category })));
    } catch (error) {
      console.warn(
        'Failed to initialize orchestrator services:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * PHASE A: Generate Architect Plan
   * Calls ArchitectService to plan the workflow
   * STOPS here - does not proceed to validation without explicit approval
   */
  async phaseA_GeneratePlan(userPrompt: string): Promise<ArchitectPlan> {
    this.audit('A_PLANNING', 'Phase A started: Generating Architect plan');

    try {
      if (!this.architectService) {
        throw new Error('ArchitectService not initialized');
      }

      console.log('\n🤖 Phase A: Architect Planning');
      console.log('─'.repeat(60));
      console.log(`📝 Generating plan for: ${userPrompt.substring(0, 100)}...`);

      const planRequest = {
        goal: userPrompt,
        description: userPrompt,
        context: 'User-provided prompt',
      };

      const planResult = await this.architectService.createPlanFromRequest(planRequest.goal, this.signal);

      // Check for error response
      if ('error_code' in planResult) {
        throw new Error(planResult.error_message);
      }

      // It's a valid plan
      const plan = planResult;

      this.executionContext.currentPlan = plan;
      this.executionContext.planningComplete = true;

      console.log(`✅ Plan generated with ${plan.steps.length} steps`);
      console.log(`   Confidence: ${(plan.confidence_score * 100).toFixed(0)}%`);
      // console.log(`   Plan ID: ${plan.plan_id}\n`); // plan_id missing in type, using timestamp or generic

      this.audit('A_PLANNING', 'Phase A complete: Plan generated', {
        stepCount: plan.steps.length,
        confidence: plan.confidence_score,
      });

      return plan;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.audit('A_PLANNING', 'Phase A failed', { error: message });
      throw new Error(`Phase A planning failed: ${message}`);
    }
  }

  /**
   * PHASE B: Steering Gate / Checkpoint Validation
   * Display plan to user via Phase 5 steering interface
   * Get approval to proceed (or reject/edit)
   */
  async phaseB_ValidateWithSteering(plan: ArchitectPlan): Promise<CheckpointDecision> {
    this.audit('B_VALIDATION', 'Phase B started: Steering gate validation');

    try {
      if (!this.planConverter || !this.checkpointHandler) {
        throw new Error('Services not initialized');
      }

      console.log('\n👤 Phase B: Steering Validation');
      console.log('─'.repeat(60));

      // Convert plan to Workflow for display in checkpoint
      const conversionResult = await this.planConverter.convert(plan);

      if (!conversionResult.success) {
        throw new Error('Failed to convert plan to workflow');
      }

      // Store hallucinations for display
      this.executionContext.hallucinations = conversionResult.hallucinations;

      console.log(`📋 Displaying plan for approval...`);
      if (conversionResult.hallucinations.length > 0) {
        console.log(
          `⚠️  ${conversionResult.hallucinations.length} hallucination alert(s) detected`,
        );
      }

      // Get user approval via steering interface
      let decision: CheckpointDecision;

      if (this.config.autoApprove) {
        // Non-interactive: Auto-approve
        decision = await this.checkpointHandler.autoApprove(
          conversionResult.workflow,
          conversionResult.hallucinations,
        );
        console.log('✓ Auto-approved (non-interactive mode)');
      } else if (this.config.steeringEnabled) {
        // Interactive: Show steering UI
        decision = await this.checkpointHandler.getApproval(
          conversionResult.workflow,
          conversionResult.hallucinations,
        );
      } else {
        // Bypass steering: Auto-approve
        decision = {
          approved: true,
          action: 'approve',
          timestamp: new Date().toISOString(),
        };
      }

      if (decision.approved) {
        this.executionContext.currentCheckpointDecision = decision;
        this.executionContext.validationComplete = true;
        console.log(`✅ Plan approved by user\n`);

        this.audit('B_VALIDATION', 'Phase B complete: Plan approved', {
          action: decision.action,
          hasModifications: !!decision.modified_workflow,
        });
      } else {
        console.log(`❌ Plan rejected by user\n`);
        this.audit('B_VALIDATION', 'Phase B: Plan rejected', {
          action: decision.action,
          reason: decision.user_context,
        });
        throw new Error('Plan rejected by user');
      }

      return decision;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.audit('B_VALIDATION', 'Phase B failed', { error: message });
      throw new Error(`Phase B validation failed: ${message}`);
    }
  }

  /**
   * PHASE C: Plan-to-Workflow Conversion + Tool Injection
   * Convert ArchitectPlan to optimized WorkflowSteps
   * Inject only requested tools (massive token savings via ToolPruner)
   * Apply steering modifications
   */
  async phaseC_ConvertAndInjectTools(
    plan: ArchitectPlan,
    decision: CheckpointDecision,
  ): Promise<WorkflowStep[]> {
    if (!decision.approved) throw new Error('Approval required before conversion');
    this.audit('C_CONVERSION', 'Phase C started: Plan conversion + tool injection');

    try {
      if (!this.planConverter || !this.toolPruner) {
        throw new Error('Services not initialized');
      }

      console.log('\n⚙️  Phase C: Conversion & Tool Injection');
      console.log('─'.repeat(60));

      // Convert plan to Workflow
      const conversionResult = await this.planConverter.convert(plan);

      if (!conversionResult.success) {
        throw new Error('Failed to convert plan');
      }

      // Apply steering modifications if workflow was modified
      const workflow = decision.modified_workflow || conversionResult.workflow;

      console.log(`🔧 Converting ${workflow.steps.length} plan steps to executable steps...`);

      // Inject only requested tools using ToolPruner
      const injectedSteps: WorkflowStep[] = [];

      for (let idx = 0; idx < workflow.steps.length; idx++) {
        const step = workflow.steps[idx];

        // Extract tool needed from this step
        const toolId = step.tools[0]?.id;
        if (!toolId) {
          throw new Error(`Step ${idx} has no tool specified`);
        }

        // Use ToolPruner to get ONLY this tool's full schema
        const toolInfo = this.toolPruner.getToolById(toolId);

        if (!toolInfo) {
          // Tool not found - this shouldn't happen after converter validation
          console.warn(`⚠️  Tool "${toolId}" not found in catalog, using as-is`);
        }

        // Inject tool schema into step
        const injectedStep: WorkflowStep = {
          ...step,
          tools: toolInfo ? [toolInfo as any] : step.tools,
          // Add metadata for audit
          metadata: {
            ...step.metadata,
            tool_injection_timestamp: new Date().toISOString(),
          },
        };

        injectedSteps.push(injectedStep);
      }

      this.executionContext.generatedSteps = injectedSteps;
      this.executionContext.conversionComplete = true;

      console.log(`✅ Converted ${injectedSteps.length} steps with tool injection`);
      console.log(`   Ready for execution\n`);

      this.audit('C_CONVERSION', 'Phase C complete: Steps converted and tools injected', {
        stepCount: injectedSteps.length,
        toolsInjected: injectedSteps.length,
      });

      return injectedSteps;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.audit('C_CONVERSION', 'Phase C failed', { error: message });
      throw new Error(`Phase C conversion failed: ${message}`);
    }
  }

  /**
   * PHASE D: Resume Execution with Builder Agent
   * Execute converted steps using BuilderAgent
   * Capture complete audit trail for Phase 7 RLHF
   */
  async phaseD_ExecuteWithBuilder(steps: WorkflowStep[]): Promise<ExecutionResult> {
    if (!this.executionContext.currentCheckpointDecision?.approved) throw new Error('Approval required before execution');
    this.audit('D_EXECUTION', 'Phase D started: Builder execution');

    try {
      if (!this.builderAgent) {
        throw new Error('BuilderAgent not initialized');
      }

      console.log('\n🏗️  Phase D: Builder Execution');
      console.log('─'.repeat(60));
      console.log(`⚡ Executing ${steps.length} steps with Builder Agent...\n`);

      // Create a synthetic Workflow for Builder to execute
      const executionWorkflow: Workflow = {
        name: `Orchestrated Workflow (${new Date().toISOString()})`,
        description: 'Steps generated by Phase 6 orchestrator',
        steps,
        config: {
          timeout: this.config.timeout,
        },
        metadata: {
          architect_plan_id: 'auto-switch-dummy',
          confidence_score: 1,
          conversion_timestamp: new Date().toISOString(),
          tool_count: steps.length,
          hallucination_count: 0
        }
      };

      // Execute with Builder
      const result = await this.builderAgent.execute(executionWorkflow, { permissions: new Set(this.config.permissions),
        approved: this.executionContext.currentCheckpointDecision?.approved ?? false, ...(this.signal ? { signal: this.signal } : {}) });

      this.executionContext.executionResult = result;

      // Log summary
      console.log(`\n✅ Execution complete`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Steps executed: ${result.steps_executed}/${result.total_steps}`);
      console.log(`   Duration: ${(result.execution_time_ms / 1000).toFixed(1)}s`);
      console.log(`   Audit trail: ${result.audit_trail_id}\n`);

      this.audit('D_EXECUTION', 'Phase D complete: Execution finished', {
        status: result.status,
        executedSteps: result.steps_executed,
        totalSteps: result.total_steps,
        duration: result.execution_time_ms,
      });

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.audit('D_EXECUTION', 'Phase D failed', { error: message });
      throw new Error(`Phase D execution failed: ${message}`);
    }
  }

  /**
   * Execute full orchestration pipeline: A → B → C → D
   * Coordinates all phases in sequence
   */
  async executeFullPipeline(userPrompt: string, signal?: AbortSignal): Promise<{
    plan: ArchitectPlan;
    decision: CheckpointDecision;
    steps: WorkflowStep[];
    result: ExecutionResult;
  }> {
    console.log('\n' + '='.repeat(60));
    if (this.running) throw new Error('Orchestrator already has an active execution');
    this.running = true;
    this.executionContext = { mode: this.config.mode, hallucinations: [], auditTrail: [],
      planningComplete: false, validationComplete: false, conversionComplete: false, startTime: new Date() };
    this.signal = signal;
    console.log('AUTO-SWITCH ORCHESTRATOR: Full Pipeline');
    console.log('='.repeat(60));

    try {
      // Phase A: Generate plan
      signal?.throwIfAborted();
      const plan = await this.phaseA_GeneratePlan(userPrompt);

      // Phase B: Validate with steering
      const decision = await this.phaseB_ValidateWithSteering(plan);

      // Phase C: Convert and inject tools
      signal?.throwIfAborted();
      const steps = await this.phaseC_ConvertAndInjectTools(plan, decision);

      // Phase D: Execute with builder
      const result = await this.phaseD_ExecuteWithBuilder(steps);

      console.log('='.repeat(60));
      console.log(`✅ ORCHESTRATION COMPLETE`);
      console.log('='.repeat(60) + '\n');

      return { plan, decision, steps, result };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error('\n❌ ORCHESTRATION FAILED:', message);
      throw error;
    } finally {
      this.signal = undefined;
      this.running = false;
    }
  }

  /**
   * Execute pipeline with mode-based behavior
   * Handles auto-switch, plan-only, execute-only modes
   */
  async executeModeAware(userPrompt: string): Promise<PlannerExecutionContext> {
    const context = this.executionContext;

    switch (this.config.mode) {
      case PlannerExecutionMode.PLAN_ONLY:
        // Only generate plan, stop
        const plan = await this.phaseA_GeneratePlan(userPrompt);
        context.currentPlan = plan;
        return context;

      case PlannerExecutionMode.AUTO_SWITCH:
        // Full pipeline: A → B → C → D
        const result = await this.executeFullPipeline(userPrompt);
        context.currentPlan = result.plan;
        context.currentCheckpointDecision = result.decision;
        context.generatedSteps = result.steps;
        context.executionResult = result.result;
        return context;

      case PlannerExecutionMode.AUTO_EXECUTE:
        // Plan + Execute without steering approval
        const planA = await this.phaseA_GeneratePlan(userPrompt);
        const decision: CheckpointDecision = {
          approved: true,
          action: 'approve',
          timestamp: new Date().toISOString(),
        };
        this.executionContext.currentCheckpointDecision = decision;
        const stepsC = await this.phaseC_ConvertAndInjectTools(planA, decision);
        const resultD = await this.phaseD_ExecuteWithBuilder(stepsC);
        context.currentPlan = planA;
        context.currentCheckpointDecision = decision;
        context.generatedSteps = stepsC;
        context.executionResult = resultD;
        return context;

      case PlannerExecutionMode.TRADITIONAL:
      case PlannerExecutionMode.EXECUTE_ONLY:
        // Traditional execution, no planning
        console.log('📋 Traditional mode: No planning phase');
        return context;

      default:
        throw new Error(`Unknown execution mode: ${this.config.mode}`);
    }
  }

  /**
   * Get current execution context state
   */
  getContext(): PlannerExecutionContext {
    return this.executionContext;
  }

  /**
   * Get audit trail
   */
  getAuditTrail(): PlannerAuditEntry[] {
    return this.executionContext.auditTrail;
  }

  /**
   * Add audit entry
   */
  private audit(
    phase: PlannerAuditEntry['phase'],
    event: string,
    details?: unknown,
  ): void {
    this.executionContext.auditTrail.push({
      timestamp: new Date().toISOString(),
      phase,
      event,
      details,
    });
  }

  /**
   * Get phase status
   */
  getPhaseStatus(): {
    planning: boolean;
    validation: boolean;
    conversion: boolean;
    execution: boolean;
  } {
    return {
      planning: this.executionContext.planningComplete,
      validation: this.executionContext.validationComplete,
      conversion: this.executionContext.conversionComplete,
      execution: !!this.executionContext.executionResult,
    };
  }

  /**
   * Display execution summary
   */
  displaySummary(): void {
    const ctx = this.executionContext;
    const status = this.getPhaseStatus();

    console.log('\n📊 Orchestrator Summary');
    console.log('─'.repeat(60));
    console.log(`Mode: ${this.config.mode}`);
    console.log(`\nPhase Status:`);
    console.log(`  A) Planning:   ${status.planning ? '✅' : '⏳'}`);
    console.log(`  B) Validation: ${status.validation ? '✅' : '⏳'}`);
    console.log(`  C) Conversion: ${status.conversion ? '✅' : '⏳'}`);
    console.log(`  D) Execution:  ${status.execution ? '✅' : '⏳'}`);

    if (ctx.currentPlan) {
      console.log(`\nPlan:`);
      console.log(`  ID: ${ctx.currentPlan.plan_id}`);
      console.log(`  Steps: ${ctx.currentPlan.steps.length}`);
      console.log(`  Confidence: ${(ctx.currentPlan.confidence_score * 100).toFixed(0)}%`);
    }

    if (ctx.hallucinations.length > 0) {
      console.log(`\nHallucinations Detected: ${ctx.hallucinations.length}`);
      for (const h of ctx.hallucinations) {
        console.log(`  - ${h.step_tool_requested} → ${h.tool_id_suggested}`);
      }
    }

    if (ctx.executionResult) {
      console.log(`\nExecution Results:`);
      console.log(`  Status: ${ctx.executionResult.status}`);
      console.log(`  Steps: ${ctx.executionResult.steps_executed}/${ctx.executionResult.total_steps}`);
      console.log(`  Duration: ${(ctx.executionResult.execution_time_ms / 1000).toFixed(1)}s`);
    }

    console.log(`\nAudit Trail Entries: ${ctx.auditTrail.length}\n`);
  }
}

/**
 * Helper: Create orchestrator from CLI flags
 */
export function createOrchestratorFromFlags(flags: {
  plan?: boolean;
  execute?: boolean;
  autoApprove?: boolean;
  noSteering?: boolean;
}): AutoSwitchOrchestrator {
  let mode: PlannerExecutionMode;

  if (flags.plan && !flags.execute) {
    mode = PlannerExecutionMode.PLAN_ONLY;
  } else if (!flags.plan && flags.execute) {
    mode = PlannerExecutionMode.EXECUTE_ONLY;
  } else if (flags.autoApprove) {
    mode = PlannerExecutionMode.AUTO_EXECUTE;
  } else {
    mode = PlannerExecutionMode.AUTO_SWITCH;
  }

  return new AutoSwitchOrchestrator({
    mode,
    steeringEnabled: !flags.noSteering,
    autoApprove: flags.autoApprove || false,
  });
}
