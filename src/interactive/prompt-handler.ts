/**
 * Interactive Prompt Handler for Safety Guardrail Approval
 * Handles pause-mode violations with human-in-the-loop decision flow
 * Now with Inquirer integration for colored, interactive prompts
 * 
 * Layer 6: Human Gate Enhancement
 * - Injects tool context (name, category, scope, resource profile)
 * - Displays risk assessment based on tool metadata
 * - Shows tool status indicators
 */

import { launchEditor } from './editor-process.js';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import inquirer from 'inquirer';
import { SafetyViolation } from '../types/index';
import { UIManager } from '../ui/ui-manager.js';
import { TerminalUI } from '../ui/terminal-ui.js';
import type { ToolDescriptor } from '../types/tool-discovery.js';

/**
 * User decision from interactive prompt
 */
export type UserDecision = 'allow' | 'deny' | 'inspect';

/**
 * Layer 6: Tool context for approval prompts
 * Displays risk assessment and tool status
 */
export interface ApprovalContext {
  violation: SafetyViolation;
  stepId: string;
  content: string;
  toolMetadata?: ToolDescriptor | undefined;  // Tool being executed (Layer 6)
}

/**
 * Determine risk indicator color based on tool metadata
 * Layer 6: Visual risk assessment
 * 
 * 🟢 Known official tools from registry
 * 🟡 Category-matched patterns (heuristic match)
 * 🔴 Unknown tools (not in registry)
 */
export function getToolRiskIndicator(toolMetadata?: ToolDescriptor): string {
  if (!toolMetadata) return '🔴'; // Unknown
  if (toolMetadata.isOfficial) return '🟢'; // Known & official
  return '🟡'; // Known but community tool
}

/**
 * Check if running in interactive terminal environment
 * Returns false for CI/CD, non-TTY, or piped stdin
 * 
 * Uses explicit true check (not falsy) to handle undefined safely
 */
export function isInteractiveEnvironment(): boolean {
  // Use strict equality check for TTY (handles undefined, false, true correctly)
  if (process.stdin.isTTY !== true) return false;

  // Check common CI/CD environment variables
  const ciEnvVars = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'CIRCLECI',
    'JENKINS_URL',
    'TRAVIS',
    'BUILDKITE',
    'DRONE',
  ];

  return !ciEnvVars.some((envVar) => process.env[envVar]);
}

/**
 * Format violation details with tool context (Layer 6)
 * Enhanced with tool metadata, risk assessment, and resource profile
 */
export function formatViolationBox(
  violation: SafetyViolation, 
  stepId: string,
  toolMetadata?: ToolDescriptor
): string {
  const lines: string[] = [];

  // Top border
  lines.push('┌' + '─'.repeat(78) + '┐');

  // Title
  const severityEmoji =
    violation.severity === 'block' ? '🔴' : violation.severity === 'pause' ? '🟠' : '🟡';
  const title = `${severityEmoji} Safety Violation Detected in Step: ${stepId}`;
  const padding = Math.max(0, 78 - title.length);
  lines.push('│ ' + title + ' '.repeat(padding) + ' │');

  // Separator
  lines.push('├' + '─'.repeat(78) + '┤');

  // Category and pattern
  lines.push(`│ Category:      ${violation.category.toUpperCase().padEnd(59)} │`);
  lines.push(`│ Pattern:       ${violation.pattern.substring(0, 59).padEnd(59)} │`);
  lines.push(`│ Confidence:    ${(violation.confidence * 100).toFixed(0)}%${' '.repeat(53)} │`);

  // Layer 6: Tool context (if available)
  if (toolMetadata) {
    const riskIndicator = getToolRiskIndicator(toolMetadata);
    lines.push('├' + '─'.repeat(78) + '┤');
    lines.push(`│ ${riskIndicator} Tool Context:`);
    lines.push(`│    Name:       ${toolMetadata.name.substring(0, 59).padEnd(59)} │`);
    lines.push(`│    Category:   ${toolMetadata.category.substring(0, 59).padEnd(59)} │`);
    lines.push(
      `│    Scope:      ${toolMetadata.scope} ${' '.repeat(57 - toolMetadata.scope.length)} │`
    );
    lines.push(
      `│    Language:   ${toolMetadata.languages.join(', ').substring(0, 54).padEnd(54)} │`
    );
    
    // Resource profile
    const resourceProfile = toolMetadata.estimatedResourceProfile;
    lines.push(
      `│    Resources:  CPU: ${resourceProfile.cpu} | Memory: ${resourceProfile.memory} │`
    );
  }

  // Matched text (wrapped if necessary)
  lines.push('├' + '─'.repeat(78) + '┤');
  const matchText = `Match: "${violation.match.substring(0, 70)}"`;
  lines.push(`│ ${matchText.padEnd(77)} │`);

  // Line number
  lines.push(`│ Line:          ${violation.line}${' '.repeat(62)} │`);

  // Remediation
  lines.push('├' + '─'.repeat(78) + '┤');
  lines.push('│ Remediation:                                                              │');

  // Wrap remediation text at 70 chars
  const remediationLines = wrapText(violation.remediation, 70);
  for (const remLine of remediationLines) {
    lines.push(`│ • ${remLine.padEnd(72)} │`);
  }

  // Bottom border
  lines.push('└' + '─'.repeat(78) + '┘');

  return lines.join('\n');
}

/**
 * Wrap text to specified width
 */
function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).length > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Display formatted decision prompt with options
 */
export function displayDecisionPrompt(): string {
  return `
┌──────────────────────────────────────────────────────────────┐
│           What would you like to do?                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [A] Approve    - Allow variable to persist and continue    │
│                                                              │
│  [I] Inspect    - Review violation details in \$EDITOR      │
│                                                              │
│  [D] Deny       - Block variable and fail this step         │
│                                                              │
│  (Press 'a', 'i', or 'd', then Enter)                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
`;
}

/**
 * Parse user input and return decision
 */
export function parseUserInput(input: string): UserDecision | null {
  const normalized = input.toLowerCase().trim()[0];

  switch (normalized) {
    case 'a':
      return 'allow';
    case 'i':
      return 'inspect';
    case 'd':
      return 'deny';
    default:
      return null;
  }
}

/**
 * Open output in system editor for inspection
 * Supports: $EDITOR (custom), vim, nano, gedit, VS Code, etc.
 */
export async function openInEditor(content: string, stepId: string): Promise<void> {
  const tempDir = tmpdir();
  const filename = `violation-${stepId}-${Date.now()}.txt`;
  const filepath = join(tempDir, filename);

  try {
    // Write content to temp file
    writeFileSync(filepath, content, 'utf-8');

    // Get editor command (prefer $EDITOR, fallback to common editors)
    const editor = process.env.EDITOR || 'vim';

    // Spawn editor process and wait for it to finish
    await launchEditor(editor, filepath);

    console.log(`\n📝 Closed editor. Review complete.\n`);
  } catch (error) {
    console.error(
      `❌ Failed to open editor: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

/**
 * Prompt user for safety violation approval
 * Interactive mode: Shows options, waits for input
 * Non-interactive mode: Auto-denies for safety
 * Layer 6: Inject tool context if available
 */
export async function promptForApproval(
  violation: SafetyViolation,
  stepId: string,
  content: string,
  toolMetadata?: ToolDescriptor  // Layer 6: Tool context
): Promise<{ decision: UserDecision; recorded: boolean }> {
  const isInteractive = isInteractiveEnvironment();

  // Non-interactive environments: auto-deny for safety
  if (!isInteractive) {
    console.log(
      `\n⚠️  Non-interactive environment detected (CI/CD). Blocking safety violation by default.`
    );
    console.log(`    Set decision to 'deny' for safety.`);
    return { decision: 'deny', recorded: false };
  }

  // Display violation in high-visibility box (Layer 6: with tool context)
  console.clear();
  console.log(formatViolationBox(violation, stepId, toolMetadata));
  console.log(displayDecisionPrompt());

  // Interactive mode: prompt user for decision
  const context: ApprovalContext = {
    violation,
    stepId,
    content,
    toolMetadata  // Layer 6
  };
  
  return await promptUserInteractively(context);
}

/**
 * Interactive prompt using readline (updated for Layer 6)
 * Bun-compatible with fallback to node readline
 */
async function promptUserInteractively(context: ApprovalContext): Promise<{
  decision: UserDecision;
  recorded: boolean;
}> {
  // Try using Bun's prompt function (v1.1+)
  if (typeof (globalThis as any).prompt === 'function') {
    return await promptWithBunNative(context);
  }

  // Fallback to readline module
  return await promptWithReadline(context);
}

/**
 * Use Bun's native prompt (if available) - Layer 6
 * Bun >= 1.1 has globalThis.prompt
 */
async function promptWithBunNative(context: ApprovalContext): Promise<{
  decision: UserDecision;
  recorded: boolean;
}> {
  let decision: UserDecision | null = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (!decision && attempts < maxAttempts) {
    const input = (globalThis as any).prompt('Your choice (a/i/d): ', '');

    if (input === null) {
      // User pressed Ctrl+C or similar
      console.log('\n❌ Approval cancelled. Denying by default.');
      return { decision: 'deny', recorded: true };
    }

    decision = parseUserInput(input);

    if (!decision) {
      console.log(`❌ Invalid input. Please enter 'a', 'i', or 'd'.`);
      attempts++;
    }
  }

  if (!decision) {
    console.log('\n❌ Max attempts exceeded. Denying by default.');
    return { decision: 'deny', recorded: true };
  }

  // Handle inspect option
  if (decision === 'inspect') {
    try {
      await openInEditor(context.content, context.stepId);
      // After inspection, ask again
      console.log(displayDecisionPrompt());
      return await promptUserInteractively(context);
    } catch (error) {
      console.error(`Failed to open editor: ${error}`);
      console.log('Denying by default due to editor error.');
      return { decision: 'deny', recorded: true };
    }
  }

  return { decision, recorded: true };
}

/**
 * Use Node.js readline module (Bun compatible) - Layer 6
 * Includes 5-second timeout to prevent hanging on non-TTY environments
 */
async function promptWithReadline(context: ApprovalContext): Promise<{
  decision: UserDecision;
  recorded: boolean;
}> {
  // Dynamically import readline (compatible with both Node and Bun)
  const readline = await import('readline');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Create timeout promise (5 seconds) - prevents hanging in CI/CD if isInteractiveEnvironment failed
  const timeoutPromise = new Promise<{ decision: UserDecision; recorded: boolean }>((resolve) => {
    const timeoutId = setTimeout(() => {
      rl.close();
      console.log('\n⏱️  Prompt timeout (5s). Denying by default for safety.');
      resolve({ decision: 'deny', recorded: true });
    }, 5000);

    // Cleanup timeout if readline resolves first
    rl.once('close', () => clearTimeout(timeoutId));
  });

  // Main prompt promise
  const promptPromise = new Promise<{ decision: UserDecision; recorded: boolean }>((resolve) => {
    let decision: UserDecision | null = null;
    let attempts = 0;
    const maxAttempts = 3;

    const askQuestion = (): void => {
      if (decision) {
        // Handle inspect option (ask again after editor closes)
        if (decision === 'inspect') {
          openInEditor(context.content, context.stepId)
            .then(() => {
              console.log(displayDecisionPrompt());
              decision = null; // Reset to ask again
              askQuestion();
            })
            .catch(() => {
              console.log('Denying by default due to editor error.');
              rl.close();
              resolve({ decision: 'deny', recorded: true });
            });
          return;
        }

        rl.close();
        resolve({ decision, recorded: true });
        return;
      }

      if (attempts >= maxAttempts) {
        rl.close();
        console.log('\n❌ Max attempts exceeded. Denying by default.');
        resolve({ decision: 'deny', recorded: true });
        return;
      }

      rl.question('Your choice (a/i/d): ', (input) => {
        const parsed = parseUserInput(input);

        if (!parsed) {
          console.log(`❌ Invalid input. Please enter 'a', 'i', or 'd'.`);
          attempts++;
          askQuestion();
        } else {
          decision = parsed;
          askQuestion();
        }
      });
    };

    askQuestion();
  });

  // Return whichever resolves first (timeout or user response)
  return Promise.race([promptPromise, timeoutPromise]);
}

/**
 * Record decision in violation object
 */
export function recordDecision(violation: SafetyViolation, decision: UserDecision): void {
  violation.userDecision = decision;
  // Timestamp already set in SafetyViolation
}

/**
 * Format decision summary for logging
 */
export function formatDecisionSummary(
  decision: UserDecision,
  stepId: string,
  category: string
): string {
  const decisionIcon =
    decision === 'allow' ? '✅' : decision === 'deny' ? '🛑' : '👁️';
  const decisionText =
    decision === 'allow'
      ? 'APPROVED - Variable persisted'
      : decision === 'deny'
        ? 'DENIED - Step failed'
        : 'INSPECTED - Approved after review';

  return `\n${decisionIcon} Decision Recorded: ${decisionText}\n   Step: ${stepId} | Category: ${category}\n`;
}

/**
 * Display violation with remediation using Inquirer
 * More interactive and visually appealing than readline
 */
export async function displayViolationWithRemediation(
  violation: SafetyViolation,
  stepId: string,
  suggestedRemediation?: string
): Promise<void> {
  const ui = UIManager.getInstance();

  // Format violation details
  const violationDetails = [
    `Step:       ${TerminalUI.colors.error(stepId)}`,
    `Category:   ${TerminalUI.colors.warning(violation.category)}`,
    `Severity:   ${TerminalUI.colors.highlight(violation.severity)}`,
    `Pattern:    ${TerminalUI.colors.subtle(violation.pattern)}`,
    `Match:      ${TerminalUI.colors.info(violation.match)}`,
    `Confidence: ${TerminalUI.colors.highlight(Math.round(violation.confidence * 100) + '%')}`,
  ];

  if (suggestedRemediation) {
    violationDetails.push(`\nRemediation: ${TerminalUI.colors.success(suggestedRemediation)}`);
  } else {
    violationDetails.push(`\nRemediation: ${TerminalUI.colors.success(violation.remediation)}`);
  }

  // Display in framed box
  ui.frameBox(violationDetails, '⚠️  Safety Violation Detected');
}

/**
 * Prompt for approval using Inquirer with colored options
 * Interactive mode: Uses Inquirer list prompt
 * Non-interactive mode: Auto-denies for safety
 */
export async function promptForApprovalWithInquirer(
  violation: SafetyViolation,
  stepId: string,
  content: string
): Promise<{ decision: UserDecision; recorded: boolean }> {
  const isInteractive = isInteractiveEnvironment();

  // Non-interactive environments: auto-deny for safety
  if (!isInteractive) {
    console.log(
      `\n⚠️  ${TerminalUI.colors.warning('Non-interactive environment detected (CI/CD). Blocking safety violation by default.')}`
    );
    return { decision: 'deny', recorded: false };
  }

  // Display violation with remediation
  await displayViolationWithRemediation(violation, stepId);

  // Prompt user with Inquirer
  try {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'decision',
        message: '📋 What would you like to do?',
        choices: [
          {
            name: `${TerminalUI.colors.success('✓ Approve')} - Allow variable to persist and continue`,
            value: 'allow',
          },
          {
            name: `${TerminalUI.colors.info('👁 Inspect')} - Review violation details in $EDITOR`,
            value: 'inspect',
          },
          {
            name: `${TerminalUI.colors.error('✗ Deny')} - Block variable and fail this step`,
            value: 'deny',
          },
        ],
        default: 'deny', // Safe default
      },
    ]);

    const decision: UserDecision = answers.decision;
    recordDecision(violation, decision);

    // If inspect selected, open editor and re-prompt
    if (decision === 'inspect') {
      await openInEditor(content, stepId);
      // Re-prompt after inspection
      return await promptForApprovalWithInquirer(violation, stepId, content);
    }

    return { decision, recorded: true };
  } catch (error) {
    // Handle user cancellation (Ctrl+C)
    console.log(
      `\n${TerminalUI.colors.warning('⚠️  Prompt cancelled. Defaulting to DENY for safety.')}`
    );
    return { decision: 'deny', recorded: false };
  }
}

/**
 * Prompt user to confirm proceeding with remediation
 * Shows suggested fix and asks for approval to apply
 */
export async function promptForRemediationApproval(
  stepId: string,
  remediationTitle: string,
  _remediationContent?: string
): Promise<boolean> {
  const isInteractive = isInteractiveEnvironment();

  if (!isInteractive) {
    console.log(`⚠️  Non-interactive mode: Skipping remediation approval prompt`);
    return false;
  }

  try {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'approve',
        message: `Apply ${remediationTitle} to ${stepId}?`,
        default: false,
      },
    ]);

    return answers.approve;
  } catch (error) {
    return false;
  }
}
