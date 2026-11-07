/**
 * Steering Interface Handler
 * Deep Human-in-the-Loop for trajectory correction
 * 
 * When --step-mode is enabled, presents steering prompt before every tool call:
 * - [R]un: Execute tool immediately
 * - [E]dit Args: Open editor to modify arguments
 * - [A]dd Context: Inject feedback into next step
 * - [T]erminate: Stop workflow
 */

import inquirer from 'inquirer';
import { launchEditor } from './editor-process.js';
import { tmpdir } from 'os';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Steering decision from user
 */
export type SteeringAction = 'run' | 'edit' | 'add-context' | 'terminate';

export interface SteeringDecision {
  action: SteeringAction;
  modifiedArgs?: string;
  feedback?: string;
}

export interface SteeringPromptContext {
  stepId: string;
  toolName: string;
  args: string;
  reasoning: string;
}

/**
 * Present steering prompt before tool execution
 * Returns user's decision on how to proceed
 */
export async function presentSteeringPrompt(
  context: SteeringPromptContext
): Promise<SteeringDecision> {
  const { stepId, toolName, args, reasoning } = context;

  // Display proposal
  console.log('\n' + '═'.repeat(70));
  console.log(`🎛️  STEERING INTERFACE - Step: ${stepId}`);
  console.log('═'.repeat(70));
  console.log(`\n📋 Proposed Tool: ${toolName}`);
  console.log(`📝 Arguments:\n${formatArgs(args)}`);
  console.log(`💭 Reasoning: ${reasoning}\n`);

  // Present action choices
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '▶️  Run - Execute tool immediately', value: 'run' },
        { name: '✏️  Edit - Modify arguments before running', value: 'edit' },
        { name: '💬 Add Context - Inject feedback for next step', value: 'add-context' },
        { name: '⏹️  Terminate - Stop workflow', value: 'terminate' },
      ],
      loop: false,
    },
  ]);

  // Handle each action
  switch (action) {
    case 'run':
      return { action: 'run' };

    case 'edit':
      const modifiedArgs = await editArgumentsInteractively(args);
      return { action: 'edit', modifiedArgs };

    case 'add-context': {
      const feedback = await promptForContextFeedback(stepId);
      return { action: 'add-context', feedback };
    }

    case 'terminate':
      return { action: 'terminate' };

    default:
      throw new Error(`Unknown steering action: ${action}`);
  }
}

/**
 * Format arguments for display
 * Truncate long values for readability
 */
function formatArgs(args: string): string {
  const truncated = args.length > 200 ? args.substring(0, 200) + '...' : args;
  return `  ${truncated}`;
}

/**
 * Open $EDITOR to modify arguments
 * Saves to temp file, lets user edit, returns modified version
 */
export async function editArgumentsInteractively(originalArgs: string): Promise<string> {
  const editor = process.env.EDITOR || 'vim';
  const tempFile = join(tmpdir(), `arc-args-${Date.now()}.txt`);

  try {
    // Write original args to temp file
    writeFileSync(tempFile, originalArgs, 'utf-8');

    // Launch editor
    console.log(`📝 Opening ${editor} to edit arguments...`);
    await launchEditor(editor, tempFile);

    // Read modified version
    const modifiedArgs = readFileSync(tempFile, 'utf-8');

    if (modifiedArgs === originalArgs) {
      console.log('ℹ️  No changes made to arguments.');
    } else {
      console.log('✅ Arguments updated.');
    }

    return modifiedArgs;
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Prompt for context feedback to inject into next step
 * Helps correct agent trajectory (Goal Drift fix)
 */
async function promptForContextFeedback(stepId: string): Promise<string> {
  const { feedback } = await inquirer.prompt([
    {
      type: 'editor',
      name: 'feedback',
      message: `Feedback for next step after '${stepId}' (will be injected into system prompt):\n` +
        'Be specific about what the agent should do differently, what goals to pursue, or constraints to respect.',
      postfix: '.md',
      validate: (answer) => {
        if (!answer || answer.trim().length === 0) {
          return 'Please provide feedback';
        }
        return true;
      },
    },
  ]);

  return feedback;
}

/**
 * Prompt for user decision on loop resolution
 * Called when LoopDetector finds same tool called repeatedly
 */
export async function promptForLoopResolution(context: {
  stepId: string;
  toolName: string;
  recentInvocations: Array<{ tool: string; args: string }>;
}): Promise<'continue-anyway' | 'halt' | 'modify'> {
  console.log('\n' + '⚠️'.repeat(35));
  console.log('🔄 LOOP DETECTED: Same tool called repeatedly');
  console.log('⚠️'.repeat(35));
  console.log(`\nStep: ${context.stepId}`);
  console.log(`Tool: ${context.toolName}`);
  console.log(`\nRecent invocations:`);
  context.recentInvocations.forEach((inv, i) => {
    const truncated =
      inv.args.length > 50 ? inv.args.substring(0, 50) + '...' : inv.args;
    console.log(`  ${i + 1}. ${inv.tool}: ${truncated}`);
  });

  const { resolution } = await inquirer.prompt([
    {
      type: 'list',
      name: 'resolution',
      message: 'This may indicate the agent is stuck in a loop. What would you like to do?',
      choices: [
        {
          name: '🛑 Halt - Stop the workflow (recommended)',
          value: 'halt',
        },
        {
          name: '✏️  Modify - Edit step parameters and retry',
          value: 'modify',
        },
        {
          name: '▶️  Continue - Run anyway (risky)',
          value: 'continue-anyway',
        },
      ],
      loop: false,
    },
  ]);

  return resolution;
}

/**
 * Error thrown when user terminates workflow
 */
export class WorkflowTerminatedByUser extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTerminatedByUser';
  }
}
