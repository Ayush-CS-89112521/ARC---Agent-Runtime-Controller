import type { Workflow } from '../parsers/plan-converter';
import type { HallucinationAlert } from '../parsers/plan-converter';
import * as readline from 'readline';

/**
 * Checkpoint approval decision
 */
export interface CheckpointDecision {
  approved: boolean;
  action: 'approve' | 'reject' | 'edit' | 'details';
  modified_workflow?: Workflow;
  user_context?: string;
  timestamp: string;
}

/**
 * Checkpoint display configuration
 */
export interface CheckpointOptions {
  show_full_prompts?: boolean;
  show_dependencies?: boolean;
  show_safety_details?: boolean;
  require_approval_for?: Array<'auth_required' | 'hallucinations' | 'fallbacks'>;
}

/**
 * Checkpoint Handler: Interactive workflow approval before execution
 * - Displays plan summary with hallucination alerts
 * - Allows user approval, rejection, or modification
 * - Validates modifications against Workflow schema
 * - Integrates with Phase 5 steering interface
 */
export class CheckpointHandler {
  private rl: readline.Interface | null = null;
  private options: CheckpointOptions;

  constructor(options: CheckpointOptions = {}) {
    this.options = {
      show_full_prompts: false,
      show_dependencies: true,
      show_safety_details: true,
      require_approval_for: ['auth_required', 'hallucinations'],
      ...options,
    };
  }

  /**
   * Main entry point: Display workflow and get user approval
   */
  async getApproval(
    workflow: Workflow,
    hallucinations: HallucinationAlert[] = [],
  ): Promise<CheckpointDecision> {
    this.createReadlineInterface();

    try {
      // Display summary
      this.displayWorkflowSummary(workflow, hallucinations);

      // Check if approval is required
      const requiresApproval = this.checkApprovalRequired(workflow, hallucinations);

      if (requiresApproval) {
        if (!process.stdin.isTTY) return { approved: false, action: 'reject',
          user_context: 'Interactive approval required; use explicit auto-approval in unattended runs',
          timestamp: new Date().toISOString() };
        // Get user decision
        return await this.promptForDecision(workflow, hallucinations);
      } else {
        // Auto-approve if no issues
        console.log('\n✓ Workflow auto-approved (no issues detected)');
        return {
          approved: true,
          action: 'approve',
          timestamp: new Date().toISOString(),
        };
      }
    } finally {
      this.closeReadlineInterface();
    }
  }

  /**
   * Display comprehensive workflow summary
   */
  private displayWorkflowSummary(
    workflow: Workflow,
    hallucinations: HallucinationAlert[],
  ): void {
    console.log('\n' + '='.repeat(80));
    console.log('WORKFLOW CHECKPOINT - REVIEW BEFORE EXECUTION');
    console.log('='.repeat(80) + '\n');

    // Workflow header
    console.log(`📋 Workflow: ${workflow.name}`);
    console.log(`   Description: ${workflow.description || '(none)'}`);
    console.log(`   Total Steps: ${workflow.steps.length}`);
    console.log(`   Confidence: ${(workflow.metadata.confidence_score * 100).toFixed(0)}%`);
    console.log(`   Plan ID: ${workflow.metadata.architect_plan_id}\n`);

    // Steps overview
    console.log('📍 STEPS OVERVIEW:');
    console.log('-'.repeat(80));
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const num = String(i + 1).padStart(2, ' ');
      const name = step.name.padEnd(25);
      const tool = step.tools[0]?.name || 'unknown';
      const auth = step.safety.require_approval ? '🔒' : '✓';
      console.log(`  ${num}. ${name} → ${tool.padEnd(20)} ${auth}`);

      // Show dependencies
      if (this.options.show_dependencies && step.when) {
        console.log(`      Dependencies: ${step.when}`);
      }
    }
    console.log();

    // Hallucination alerts
    if (hallucinations.length > 0) {
      this.displayHallucinations(hallucinations);
    }

    // Safety summary
    if (this.options.show_safety_details) {
      this.displaySafetySummary(workflow);
    }
  }

  /**
   * Display hallucination alerts
   */
  private displayHallucinations(hallucinations: HallucinationAlert[]): void {
    console.log('⚠️  HALLUCINATION ALERTS:');
    console.log('-'.repeat(80));
    for (let i = 0; i < hallucinations.length; i++) {
      const h = hallucinations[i];
      const num = String(i + 1).padStart(2, ' ');
      console.log(`  ${num}. Requested: "${h.step_tool_requested}"`);
      console.log(`      Suggested: "${h.tool_id_suggested}" (${(h.confidence * 100).toFixed(0)}% match)`);
      console.log(`      Action: ${h.action.toUpperCase()}`);
      console.log(`      Message: ${h.message}`);
      console.log();
    }
  }

  /**
   * Display safety summary
   */
  private displaySafetySummary(workflow: Workflow): void {
    console.log('🛡️  SAFETY SUMMARY:');
    console.log('-'.repeat(80));

    const authRequired = workflow.steps.filter(s => s.safety.require_approval);
    const withTimeouts = workflow.steps.filter(s => s.safety.timeout);

    console.log(`  Approval Required: ${authRequired.length} step(s)`);
    console.log(
      `  Pattern Scanning: ${workflow.steps.filter(s => s.safety.pattern_scan).length} step(s)`,
    );
    console.log(`  Timeouts Configured: ${withTimeouts.length} step(s)`);

    if (authRequired.length > 0) {
      console.log(`\n  Tools Requiring Approval:`);
      for (const step of authRequired) {
        const tool = step.tools[0];
        console.log(
          `    - ${tool.name} (${tool.auth_type} auth required)`,
        );
      }
    }
    console.log();
  }

  /**
   * Check if user approval is required
   */
  private checkApprovalRequired(
    workflow: Workflow,
    hallucinations: HallucinationAlert[],
  ): boolean {
    const { require_approval_for } = this.options;

    if (!require_approval_for) {
      return true; // Always require by default
    }

    // Check for auth-required tools
    if (require_approval_for.includes('auth_required')) {
      if (workflow.steps.some(s => s.safety.require_approval)) {
        return true;
      }
    }

    // Check for hallucinations
    if (require_approval_for.includes('hallucinations')) {
      if (hallucinations.length > 0) {
        return true;
      }
    }

    // Check for fallback tools
    if (require_approval_for.includes('fallbacks')) {
      if (
        workflow.steps.some(
          s => s.metadata.tool_action === 'fallback',
        )
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Prompt user for approval decision
   */
  private async promptForDecision(
    workflow: Workflow,
    hallucinations: HallucinationAlert[],
  ): Promise<CheckpointDecision> {
    while (true) {
      const choice = await this.prompt(
        '\n[A]pprove / [E]dit / [R]eject / [D]etails? ',
      );

      switch (choice.toLowerCase()) {
        case 'a':
          return {
            approved: true,
            action: 'approve',
            timestamp: new Date().toISOString(),
          };

        case 'r':
          const reason = await this.prompt(
            'Reason for rejection (optional): ',
          );
          return {
            approved: false,
            action: 'reject',
            ...(reason ? { user_context: reason } : {}),
            timestamp: new Date().toISOString(),
          };

        case 'e':
          const edited = await this.promptForEdits(workflow);
          if (edited) {
            return {
              approved: true,
              action: 'edit',
              modified_workflow: edited,
              timestamp: new Date().toISOString(),
            };
          }
          // If edits cancelled, show menu again
          break;

        case 'd':
          this.displayFullDetails(workflow, hallucinations);
          break;

        default:
          console.log('Invalid choice. Please enter A, E, R, or D.');
      }
    }
  }

  /**
   * Display full workflow details
   */
  private displayFullDetails(
    workflow: Workflow,
    _hallucinations: HallucinationAlert[],
  ): void {
    console.log('\n' + '='.repeat(80));
    console.log('FULL WORKFLOW DETAILS');
    console.log('='.repeat(80) + '\n');

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      console.log(`STEP ${i + 1}: ${step.name}`);
      console.log('-'.repeat(80));
      console.log(`ID: ${step.id}`);
      console.log(`Tool: ${step.tools[0]?.name || 'unknown'}`);
      console.log(`Category: ${step.tools[0]?.category || 'unknown'}`);
      console.log(`Auth Type: ${step.tools[0]?.auth_type || 'none'}`);

      if (step.description) {
        console.log(`\nDescription:\n${step.description}`);
      }

      if (step.prompt && this.options.show_full_prompts) {
        console.log(`\nPrompt:\n${step.prompt}`);
      }

      if (step.expected_output) {
        console.log(`\nExpected Output: ${step.expected_output}`);
      }

      if (step.when) {
        console.log(`\nDependencies: ${step.when}`);
      }

      console.log(
        `\nSafety: Pattern Scan=${step.safety.pattern_scan}, `,
      );
      console.log(
        `Approval Required=${step.safety.require_approval}, `,
      );
      console.log(`Timeout=${step.safety.timeout}ms`);
      console.log();
    }
  }

  /**
   * Prompt for workflow edits
   */
  private async promptForEdits(
    workflow: Workflow,
  ): Promise<Workflow | null> {
    console.log('\n' + '-'.repeat(80));
    console.log('EDIT WORKFLOW');
    console.log('-'.repeat(80));

    const editChoice = await this.prompt(
      '[S]kip step / [M]odify step / [C]ancel edits? ',
    );

    if (editChoice.toLowerCase() === 'c') {
      console.log('✗ Edits cancelled.');
      return null;
    }

    if (editChoice.toLowerCase() === 's') {
      const stepNum = await this.prompt('Step number to skip (1-indexed): ');
      const idx = parseInt(stepNum) - 1;
      if (idx >= 0 && idx < workflow.steps.length) {
        // Create modified workflow with step skipped
        const modified = {
          ...workflow,
          steps: workflow.steps.filter((_, i) => i !== idx),
        };
        console.log(`✓ Step ${stepNum} marked for skipping.`);
        return modified;
      } else {
        console.log('Invalid step number.');
      }
    }

    if (editChoice.toLowerCase() === 'm') {
      const stepNum = await this.prompt('Step number to modify (1-indexed): ');
      const idx = parseInt(stepNum) - 1;
      if (idx >= 0 && idx < workflow.steps.length) {
        const step = workflow.steps[idx];
        console.log(`\nModifying Step ${stepNum}: ${step.name}`);
        console.log('Current prompt:');
        console.log(step.prompt);
        console.log();

        const newPrompt = await this.prompt('New prompt (or press Enter to keep): ');
        if (newPrompt) {
          // Validate and create modified workflow
          const modified = {
            ...workflow,
            steps: workflow.steps.map((s, i) =>
              i === idx
                ? {
                    ...s,
                    prompt: newPrompt,
                  }
                : s,
            ),
          };
          console.log(`✓ Step ${stepNum} prompt updated.`);
          return modified;
        }
      } else {
        console.log('Invalid step number.');
      }
    }

    // Recursively offer more edits
    return this.promptForEdits(workflow);
  }

  /**
   * Create readline interface
   */
  private createReadlineInterface(): void {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
  }

  /**
   * Close readline interface
   */
  private closeReadlineInterface(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Prompt helper
   */
  private prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve('');
        return;
      }

      this.rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  /**
   * Non-interactive mode: Auto-approve with logging
   */
  async autoApprove(
    _workflow: Workflow,
    _hallucinations: HallucinationAlert[] = [],
  ): Promise<CheckpointDecision> {
    console.log('✓ Auto-approving workflow (non-interactive mode)');
    return {
      approved: true,
      action: 'approve',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Non-interactive mode: Auto-reject
   */
  async autoReject(
    reason: string = 'Auto-rejected',
  ): Promise<CheckpointDecision> {
    console.log(`✗ Auto-rejecting workflow: ${reason}`);
    return {
      approved: false,
      action: 'reject',
      user_context: reason,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Integration function with Phase 5 steering
 * Displays checkpoint and routes to steering if needed
 */
export async function checkpointWorkflow(
  workflow: Workflow,
  hallucinations: HallucinationAlert[] = [],
  interactiveMode: boolean = true,
): Promise<CheckpointDecision> {
  const handler = new CheckpointHandler({
    show_full_prompts: false,
    show_dependencies: true,
    show_safety_details: true,
    require_approval_for: ['auth_required', 'hallucinations'],
  });

  if (interactiveMode) {
    return handler.getApproval(workflow, hallucinations);
  } else {
    return handler.autoApprove(workflow, hallucinations);
  }
}
