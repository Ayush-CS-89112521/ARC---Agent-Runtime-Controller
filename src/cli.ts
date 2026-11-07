#!/usr/bin/env bun

/**
 * ARC (Agent Runtime Controller) - CLI Entry Point
 * Main command-line interface for the workflow engine
 */

import { resolve } from 'path';
import { installSanitizedStreams, cancelSanitizedStreams } from '../arc/src/sanitizer.js';
installSanitizedStreams();
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadWorkflowFromFile, WorkflowParseError } from './parsers/workflow-parser.js';
import {
  executeWorkflowWithLogging,
  validateWorkflowBeforeExecution,
} from './engine/workflow-engine.js';
import { verifyGithubCopilotAuth } from './execution/github-auth.js';
import { UIManager } from './ui/ui-manager.js';
import { ApiDiscoveryService } from './execution/api-discovery-service.js';
import { CheckpointHandler } from './interactive/checkpoint-handler.js';

/**
 * Print CLI usage information
 */
function printUsage(): void {
  console.log(`
ARC - Agent Runtime Controller v0.1.0

Usage:
  arc <command> [options]
  arc <workflow-file> [options]
  arc <prompt-string> --plan [options]       (Phase 6c: Planning mode)

Commands:
  init <name>             Create a new workflow project (scaffolding)
  connect <tool-name>     Connect an MCP tool to current workflow
  <workflow-file>         Execute the workflow YAML file
  <prompt-string>         Generate and execute plan from natural language (Phase 6c)

Arguments for init:
  <name>                  Directory name for new workflow project (required)

Arguments for connect:
  <tool-name>             Name of MCP tool to discover and connect (required)

Arguments for planning:
  <prompt-string>         Natural language description of task (when --plan is used)

Options for init:
  --skip-readme           Don't generate README.md
  --skip-env              Don't generate .env.example
  --with-ci               Include GitHub Actions CI template

Options for workflow execution:
  --help, -h              Show this help message
  --check-auth            Verify GitHub Copilot CLI authentication status
  --timeout <ms>          Override default timeout per step (milliseconds)
  --retries <n>           Override default number of retries
  --no-fail-fast          Continue executing steps even if one fails
  --validate-output       Enable output validation (default: true)
  --step-mode             Pause before every tool call for steering/feedback
  --allow-main-push       Allow git pushes to main/master branches (Phase 5)
  --version               Show version

Options for Phase 6c (Auto-Switch Orchestrator):
  --plan                  Trigger planning mode (generate plan from prompt)
  --auto-switch           Use auto-switch orchestrator for hybrid execution
  --auto-approve          Auto-approve safe plans without user confirmation
  --execute-only          Skip planning phase, go straight to execution
  --no-steering           Disable interactive steering during execution

Examples:
  arc init my-workflow
  arc --check-auth
  arc ./workflow.yaml
  arc ./my-workflow.yaml --timeout 60000 --retries 3
  arc ./workflow.yaml --step-mode --no-fail-fast
  arc ./workflow.yaml --step-mode --allow-main-push
  arc "Refactor the login module to use async/await" --plan --auto-switch
  arc "Create a new API endpoint" --plan --auto-approve --auto-switch

Documentation: README.md
`);
}

/**
 * Print version information
 */
function printVersion(): void {
  console.log('ARC - Agent Runtime Controller v0.1.0');
}

/**
 * Parse command-line arguments
 *
 * @param args - Process arguments (excluding bun and script path)
 * @returns Parsed arguments object
 */
function parseArgs(args: string[]): {
  command?: string;
  argument?: string;
  timeout?: number;
  retries?: number;
  failFast?: boolean;
  validateOutput?: boolean;
  skipReadme?: boolean;
  skipEnv?: boolean;
  withCI?: boolean;
  checkAuth?: boolean;
  listCategories?: boolean;
  listTools?: boolean;
  searchTool?: string;
  toolInfo?: string;
  listApis?: boolean;
  searchApi?: string;
  apiInfo?: string;
  search?: string;
  stepMode?: boolean;
  allowMainPush?: boolean;
  plan?: boolean;
  autoSwitch?: boolean;
  autoApprove?: boolean;
  executeOnly?: boolean;
  noSteering?: boolean;
  help?: boolean;
  version?: boolean;
  error?: string;
} {
  const parsed: {
    command?: string;
    argument?: string;
    timeout?: number;
    retries?: number;
    failFast?: boolean;
    validateOutput?: boolean;
    skipReadme?: boolean;
    skipEnv?: boolean;
    withCI?: boolean;
    checkAuth?: boolean;
    listCategories?: boolean;
    listTools?: boolean;
    searchTool?: string;
    toolInfo?: string;
    listApis?: boolean;
    searchApi?: string;
    apiInfo?: string;
    search?: string;
    stepMode?: boolean;
    allowMainPush?: boolean;
    plan?: boolean;
    autoSwitch?: boolean;
    autoApprove?: boolean;
    executeOnly?: boolean;
    noSteering?: boolean;
    help?: boolean;
    version?: boolean;
    error?: string;
  } = {
    failFast: true, // Default: fail fast
    validateOutput: true, // Default: validate output
  };

  let positionalIndex = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--version') {
      parsed.version = true;
    } else if (arg === '--check-auth') {
      parsed.checkAuth = true;
    } else if (arg === '--list-categories') {
      parsed.listCategories = true;
    } else if (arg === '--list-tools') {
      parsed.listTools = true;
    } else if (arg === '--search-tool') {
      const value = args[++i];
      if (!value) {
        parsed.error = '--search-tool requires a query string';
      } else {
        parsed.searchTool = value;
      }
    } else if (arg === '--tool-info') {
      const value = args[++i];
      if (!value) {
        parsed.error = '--tool-info requires a tool ID';
      } else {
        parsed.toolInfo = value;
      }
    } else if (arg === '--list-apis') {
      parsed.listApis = true;
    } else if (arg === '--search-api') {
      const value = args[++i];
      if (!value) {
        parsed.error = '--search-api requires a query string';
      } else {
        parsed.searchApi = value;
      }
    } else if (arg === '--api-info') {
      const value = args[++i];
      if (!value) {
        parsed.error = '--api-info requires an API ID';
      } else {
        parsed.apiInfo = value;
      }
    } else if (arg === '--step-mode') {
      parsed.stepMode = true;
    } else if (arg === '--allow-main-push') {
      parsed.allowMainPush = true;
    } else if (arg === '--plan') {
      parsed.plan = true;
    } else if (arg === '--auto-switch') {
      parsed.autoSwitch = true;
    } else if (arg === '--auto-approve') {
      parsed.autoApprove = true;
    } else if (arg === '--execute-only') {
      parsed.executeOnly = true;
    } else if (arg === '--no-steering') {
      parsed.noSteering = true;
    } else if (arg === '--search') {
      const value = args[++i];
      if (!value) {
        parsed.error = '--search requires a query string';
      } else {
        parsed.search = value;
      }
    } else if (arg === '--skip-readme') {
      parsed.skipReadme = true;
    } else if (arg === '--skip-env') {
      parsed.skipEnv = true;
    } else if (arg === '--with-ci') {
      parsed.withCI = true;
    } else if (arg === '--timeout') {
      const value = args[++i];
      if (!value || isNaN(Number(value))) {
        parsed.error = '--timeout requires a numeric value (milliseconds)';
      } else {
        parsed.timeout = Number(value);
      }
    } else if (arg === '--retries') {
      const value = args[++i];
      if (!value || isNaN(Number(value))) {
        parsed.error = '--retries requires a numeric value';
      } else {
        parsed.retries = Number(value);
      }
    } else if (arg === '--no-fail-fast') {
      parsed.failFast = false;
    } else if (arg === '--validate-output') {
      parsed.validateOutput = true;
    } else if (!arg.startsWith('-')) {
      if (positionalIndex === 0) {
        parsed.command = arg;
      } else if (positionalIndex === 1) {
        parsed.argument = arg;
      }
      positionalIndex++;
    } else {
      parsed.error = `Unknown option: ${arg}`;
    }
  }

  return parsed;
}

/**
 * Validate project name for init command
 */
function validateProjectName(name: string): { valid: boolean; error?: string } {
  if (!name) {
    return { valid: false, error: 'Project name is required' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { valid: false, error: 'Project name can only contain alphanumeric characters, dots, hyphens, and underscores' };
  }
  if (name.length > 100) {
    return { valid: false, error: 'Project name must be 100 characters or less' };
  }
  return { valid: true };
}

/**
 * Generate workflow.yaml template showcasing all 8 layers
 */
function generateWorkflowTemplate(): string {
  return `name: "Hello World Workflow - 8-Layer Safety Architecture Showcase"
version: "1.0.0"

# This workflow demonstrates all 8 layers of safety:
# Layer 1: Schema validation ensures valid YAML structure
# Layer 2: Dependency checking prevents forward references
# Layer 3: Condition sandbox safely evaluates conditions
# Layer 4: Resource watchdog monitors CPU and memory
# Layer 5: Pattern library detects dangerous shell commands
# Layer 6: Human gate requires approval for violations
# Layer 7: Secret masking redacts credentials from logs
# Layer 8: Atomic finalization ensures crash-safe persistence

steps:
  # Step 1: Echo hello - demonstrates Layer 1 (Schema) and Layer 5 (Pattern)
  # This step is safe: "echo" is a whitelisted command
  - id: say-hello
    agent: github
    prompt: |-
      Print "Hello from Agent Runtime Controller!"
      Use the 'echo' command (safe).
    timeout: 10000
    retries: 1
    # Layer 1: schema validates this step object
    # Layer 3: no conditions, so condition sandbox is skipped
    # Layer 5: pattern library scans for dangerous patterns
    # Layer 7: no secrets, so masking doesn't apply

  # Step 2: Set environment - demonstrates Layer 2 (Dependency) and Layer 7 (Masking)
  # This step shows dependency on the previous step via variable reference
  - id: set-env
    agent: github
    prompt: |-
      Export an environment variable GREETING="Hello World"
      Then echo $GREETING
    when: true  # Layer 3: condition sandbox evaluates this safely
    timeout: 10000
    # Layer 2: variable resolution checks that 'say-hello' exists (forward reference check)
    # Layer 7: secrets would be masked if present

  # Step 3: Safe output - demonstrates Layer 6 (Human Gate)
  # If any pattern violations were detected, Layer 6 would prompt for approval
  - id: print-summary
    agent: github
    prompt: |-
      Print a summary of the execution so far
    dependsOn:
      - say-hello
      - set-env
    # Layer 6: If violations found, interactive approval prompt appears here
    # Layer 4: Resource watchdog monitors this step's resource usage
    # Layer 8: Atomic finalization writes execution context durably

# Environment variables for this workflow
# Layer 7: Any values here would be masked in logs
env:
  PROJECT_NAME: "ARC Demo"
  DEBUG: "false"

# Safety configuration - demonstrates all layer controls
safety:
  # Layer 4: Resource watchdog thresholds
  maxCpuPercent: 80
  maxMemoryMB: 512
  memoryLeakThreshold: 50

  # Layer 6: Human gate behavior
  autoApproveSafe: true
  requireApprovalForViolations: true

# Audit trail - Layer 8 persists all decisions
auditOptions:
  enableDetailedLogging: true
  persistExecutionContext: true
`;
}

/**
 * Generate .env.example template
 */
function generateEnvExample(): string {
  return `# Environment Variables for Agent Runtime Controller
# Copy this file to .env and fill in your actual values
# WARNING: Never commit .env with real credentials!

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# AUTHENTICATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# This project uses GitHub CLI (gh) for authentication.
# NO GITHUB_TOKEN NEEDED - Just run: gh auth login
# 
# The GitHub CLI handles authentication automatically.
# Ensure you have an active GitHub Copilot subscription.
#
# To verify authentication:
#   gh auth status
#   gh copilot --version
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# API Keys (if your workflow steps use external APIs)
# API_KEY=your-api-key-here
# ANOTHER_API=another-key-here

# Optional: Web Scraping Features (uses Claude API)
# ANTHROPIC_API_KEY=your_anthropic_key_here
# ENABLE_WEB_SCRAPING=true

# Debug and Development Options
# Set these to enable detailed logging during development
DEBUG=false
VERBOSE=false
CI=false

# UI and Display Options
# NO_COLORS=false      # Disable colored output
# NO_SPINNERS=false    # Disable spinner animations
# NO_FRAMES=false      # Disable box framing
# SILENT=false         # Suppress all output

# Resource Limits (optional - override workflow.yaml)
# MAX_CPU_PERCENT=80
# MAX_MEMORY_MB=512

# Safety Options
# REQUIRE_APPROVAL=true         # Always prompt for violations
# AUTO_APPROVE_SAFE=true        # Auto-approve if no violations found
# DETAILED_AUDIT=true           # Detailed execution logging
`;
}

/**
 * Generate project README.md
 */
function generateReadme(projectName: string): string {
  return `# ${projectName}

A Copilot Workflow project powered by Agent Runtime Controller.

## Quick Start

### 1. Setup Environment
\`\`\`bash
cp .env.example .env
# Edit .env with your actual values (API keys, tokens, etc.)
\`\`\`

### 2. Review the Workflow
\`\`\`bash
cat workflows/workflow.yaml
\`\`\`

### 3. Execute the Workflow
\`\`\`bash
arc workflows/workflow.yaml
\`\`\`

## Workflow Steps

| Step ID | Description | Layer Coverage |
|---------|-------------|-----------------|
| say-hello | Print hello message | Layer 1, 5 |
| set-env | Set environment variable | Layer 2, 3, 7 |
| print-summary | Print execution summary | Layer 4, 6, 8 |

## 8-Layer Safety Architecture

This workflow is protected by all 8 layers of safety:

- **Layer 1**: Schema validation ensures valid YAML structure
- **Layer 2**: Dependency checking prevents forward references
- **Layer 3**: Condition sandbox safely evaluates logic
- **Layer 4**: Resource watchdog monitors CPU/memory
- **Layer 5**: Pattern library detects dangerous commands
- **Layer 6**: Human gate requires approval for violations
- **Layer 7**: Secret masking redacts credentials from logs
- **Layer 8**: Atomic finalization ensures crash-safe persistence

For detailed information, see the main project documentation:
- [8-Layer Safety Architecture](../../SAFETY_ARCHITECTURE.md)
- [Visual Reference](../../SAFETY_ARCHITECTURE_VISUAL.md)

## Customization

Edit \`workflows/workflow.yaml\` to add your own steps:

\`\`\`yaml
steps:
  - id: my-step
    agent: github
    prompt: "Your prompt here"
    timeout: 10000
\`\`\`

## Troubleshooting

### GitHub Authentication Issues
**This project uses GitHub CLI authentication:**

\`\`\`bash
# Authenticate with GitHub CLI
gh auth login

# Verify authentication
gh auth status

# Verify Copilot CLI is available
gh copilot --version

# Test with ARC
arc --check-auth
\`\`\`

**Requirements:**
- GitHub CLI (\`gh\`) must be installed
- Active GitHub Copilot subscription on your account
- Authenticated via \`gh auth login\`

### Steps are slow
- Check system resource usage
- Increase timeout values if needed
- Layer 4 resource watchdog logs resource usage

### Workflow validation errors
- Check YAML syntax: Layer 1 schema validation
- Verify all step dependencies exist: Layer 2
- Ensure all variables are defined: Layer 2

## Documentation

- [Agent Runtime Controller Docs](../../README.md)
- [Safety Architecture](../../SAFETY_ARCHITECTURE.md)
`;
}

/**
 * Handle arc init command
 */
async function handleInitCommand(
  projectName: string,
  options: { skipReadme?: boolean; skipEnv?: boolean; withCI?: boolean }
): Promise<void> {
  const ui = UIManager.getInstance();

  // Validate project name
  const nameValidation = validateProjectName(projectName);
  if (!nameValidation.valid) {
    ui.error(`❌ Invalid project name: ${nameValidation.error}`);
    process.exit(1);
  }

  // Check if directory already exists
  if (existsSync(projectName)) {
    ui.error(`❌ Directory '${projectName}' already exists`);
    process.exit(1);
  }

  try {
    ui.log(ui.format('📁 Creating project directories...', 'info'));

    // Create directory structure
    const baseDir = resolve(projectName);
    await mkdir(baseDir, { recursive: true });
    await mkdir(join(baseDir, 'workflows'), { recursive: true });
    await mkdir(join(baseDir, 'outputs'), { recursive: true });
    await mkdir(join(baseDir, 'docs'), { recursive: true });

    ui.log(ui.format('✓ Created directories', 'success'));

    // Generate and write workflow.yaml
    ui.log(ui.format('📝 Generating workflow.yaml...', 'info'));
    const workflowContent = generateWorkflowTemplate();
    await writeFile(join(baseDir, 'workflows', 'workflow.yaml'), workflowContent, 'utf-8');
    ui.log(ui.format(`✓ Generated workflows/workflow.yaml (${workflowContent.split('\n').length} lines)`, 'success'));

    // Generate and write .env.example
    if (!options.skipEnv) {
      ui.log(ui.format('📝 Generating .env.example...', 'info'));
      const envContent = generateEnvExample();
      await writeFile(join(baseDir, '.env.example'), envContent, 'utf-8');
      ui.log(ui.format('✓ Generated .env.example', 'success'));
    }

    // Generate and write README.md
    if (!options.skipReadme) {
      ui.log(ui.format('📝 Generating README.md...', 'info'));
      const readmeContent = generateReadme(projectName);
      await writeFile(join(baseDir, 'README.md'), readmeContent, 'utf-8');
      ui.log(ui.format('✓ Generated README.md', 'success'));
    }

    // Print summary
    ui.log('');
    ui.log(ui.format('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'highlight'));
    ui.log(ui.format(`✅ Workflow project '${projectName}' created successfully!`, 'success'));
    ui.log(ui.format('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'highlight'));
    ui.log('');

    // Print next steps
    ui.log(ui.format('📖 Next Steps:', 'info'));
    ui.log(`  1. ${ui.format(`cd ${projectName}`, 'highlight')}`);
    ui.log(`  2. ${ui.format('cp .env.example .env', 'highlight')}`);
    ui.log(`  3. ${ui.format('# Edit .env with your credentials', 'highlight')}`);
    ui.log(`  4. ${ui.format('arc workflows/workflow.yaml', 'highlight')}`);
    ui.log('');
    ui.log(ui.format('📚 Learn more: See workflows/workflow.yaml and README.md', 'subtle'));
    ui.log(ui.format('🔒 All 8 safety layers are active - review SAFETY_ARCHITECTURE.md', 'subtle'));
    ui.log('');
  } catch (error) {
    ui.error(`❌ Failed to create workflow project: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────
// CONNECT COMMAND HANDLER (Tool Discovery Layer)
// ─────────────────────────────────────────────────────────────────

/**
 * Handle 'arc connect <tool-name>' command
 * Discovers tool from MCP registry and generates workflow step
 */
async function handleConnectCommand(
  toolName: string,
  options: { workflow?: string; stepId?: string }
): Promise<void> {
  const ui = UIManager.getInstance();

  try {
    // Dynamic import to avoid circular dependencies
    const { ToolDiscoveryService } = await import('./execution/tool-discovery-resolver.js');
    const yaml = await import('yaml');
    const { writeFile, readFile } = await import('fs/promises');

    ui.log(ui.format(`🔍 Searching for MCP tool: '${toolName}'...`, 'info'));

    // Initialize tool discovery service
    const service = new ToolDiscoveryService();
    const tool = await service.findTool(toolName);

    if (!tool) {
      ui.error(`❌ Tool '${toolName}' not found in MCP registry`);
      ui.log('');
      ui.log(ui.format('💡 Try searching with:', 'subtle'));
      ui.log(`   arc --list-tools`);
      process.exit(1);
    }

    // Check availability
    const availability = await service.checkAvailability(tool);

    ui.log(ui.format(`✅ Found tool: ${tool.name} (${tool.category})`, 'success'));
    ui.log(`   📦 Repository: ${tool.repositoryUrl}`);
    ui.log(`   🔧 Languages: ${tool.languages.join(', ')}`);
    ui.log(`   🎯 Scope: ${tool.scope === 'cloud_service' ? '☁️ Cloud' : '🏠 Local'}`);

    // Check environment variables
    if (availability.missingEnvVars.length > 0) {
      ui.log('');
      ui.log(ui.format('⚠️  Missing environment variables:', 'warning'));
      availability.missingEnvVars.forEach(v => {
        ui.log(`   - ${v}`);
      });
      ui.log(ui.format('Add these to your .env file before using this tool', 'subtle'));
    }

    // Generate step configuration
    const stepId = options.stepId || `tool_${tool.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
    const timeoutMultiplier = tool.estimatedResourceProfile.timeoutMultiplier;
    const defaultTimeout = 30000; // 30 seconds
    const adjustedTimeout = Math.round(defaultTimeout * timeoutMultiplier);

    const memoryProfile: Record<'low' | 'medium' | 'high', number> = {
      'low': 256,
      'medium': 512,
      'high': 1024,
    };

    const cpuProfile: Record<'light' | 'medium' | 'heavy', number> = {
      'light': 80,
      'medium': 70,
      'heavy': 60,
    };

    const newStep = {
      id: stepId,
      name: `${tool.name} Integration`,
      agent: 'suggest',
      prompt: `Using \${tools.${tool.name.toLowerCase()}}: [PLACEHOLDER - describe your task here]`,
      output: {
        type: 'variable',
        name: `${stepId}_result`,
      },
      timeout: adjustedTimeout,
      resources: {
        memoryMB: memoryProfile[tool.estimatedResourceProfile.memory],
        cpuWarnPercent: cpuProfile[tool.estimatedResourceProfile.cpu],
      },
      metadata: {
        toolId: tool.id,
        discoveredAt: new Date().toISOString(),
        suggestedMcpCommand: availability.mcpCommand,
      },
      safety: {
        categorizeAs: tool.category,
      },
    };

    // Determine workflow file path
    const workflowPath = options.workflow || (
      existsSync('workflow.yaml') ? 'workflow.yaml' :
        existsSync('./workflows/workflow.yaml') ? './workflows/workflow.yaml' :
          null
    );

    if (!workflowPath || !existsSync(workflowPath)) {
      ui.log('');
      ui.log(ui.format('📝 Generated step configuration:', 'info'));
      ui.log('');
      ui.log(JSON.stringify(newStep, null, 2));
      ui.log('');
      ui.log(ui.format('❌ No workflow.yaml found. Create one with:', 'warning'));
      ui.log(`   arc init my-workflow`);
      process.exit(1);
    }

    // Read existing workflow
    const workflowContent = await readFile(workflowPath, 'utf-8');
    const workflow = yaml.parse(workflowContent);

    // Add new step
    if (!workflow.steps) {
      workflow.steps = [];
    }

    const stepExists = workflow.steps.some((s: any) => s.id === stepId);
    if (stepExists) {
      ui.log(ui.format(`⚠️  Step with ID '${stepId}' already exists, generating new ID...`, 'warning'));
      newStep.id = `${stepId}_${Math.random().toString(36).substring(7)}`;
    }

    workflow.steps.push(newStep);

    // Write back workflow
    const updatedWorkflow = yaml.stringify(workflow, { indent: 2, lineWidth: -1 });
    await writeFile(workflowPath, updatedWorkflow, 'utf-8');

    ui.log('');
    ui.log(ui.format('✅ Step added to workflow:', 'success'));
    ui.log(`   Workflow: ${workflowPath}`);
    ui.log(`   Step ID: ${newStep.id}`);
    ui.log('');
    ui.log(ui.format('📝 Next steps:', 'info'));
    ui.log(`   1. Edit the prompt in ${workflowPath}:`);
    ui.log(`      Replace '[PLACEHOLDER - describe your task here]' with your instruction`);
    if (availability.missingEnvVars.length > 0) {
      ui.log(`   2. Add required environment variables to .env`);
      ui.log(`   3. Run: arc ${workflowPath}`);
    } else {
      ui.log(`   2. Run: arc ${workflowPath}`);
    }

    ui.log('');
    if (availability.mcpCommand) {
      ui.log(ui.format('💡 MCP Server Command:', 'info'));
      ui.log(`   ${availability.mcpCommand}`);
      ui.log('');
    }

  } catch (error) {
    ui.error(`❌ Failed to connect tool: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

/**
 * Main CLI entry point
 * Parses arguments, loads workflow, and executes it
 */

// ─────────────────────────────────────────────────────────────────
// ADD-API COMMAND HANDLERS (Phase 4)
// ─────────────────────────────────────────────────────────────────

/**
 * Load the API registry from data/api-registry.json
 */
async function handleListApis(): Promise<void> {
  try {
    const service = new ApiDiscoveryService();
    const categories = await service.getCategories();
    const registry = await service.loadRegistry();

    console.log('\n┌─ Public APIs Catalog ─────────────────────────┐');
    console.log(`│ Total APIs: ${registry.entries.length}`.padEnd(48) + '│');
    console.log(`│ Categories: ${categories.length}`.padEnd(48) + '│');
    console.log(`│ Last Updated: ${new Date(registry.lastUpdated).toLocaleDateString()}`.padEnd(48) + '│');
    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Top Categories:                                │');

    // Count APIs per category
    const categoryCounts = new Map<string, number>();
    for (const api of registry.entries) {
      categoryCounts.set(api.category, (categoryCounts.get(api.category) || 0) + 1);
    }

    // Sort by count desc
    const sortedCategories = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    for (const [cat, count] of sortedCategories) {
      console.log(`│   ${cat}: ${count}`.padEnd(48) + '│');
    }

    if (categories.length > 15) {
      console.log(`│   ... and ${categories.length - 15} more categories`.padEnd(48) + '│');
    }

    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Usage:                                         │');
    console.log('│   arc --search-api <query>                     │');
    console.log('│   arc --api-info <api-id>                      │');
    console.log('└────────────────────────────────────────────────┘\n');
  } catch (error) {
    console.error(`\n❌ Failed to list APIs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

async function handleSearchApi(query: string): Promise<void> {
  try {
    const service = new ApiDiscoveryService();
    const results = await service.searchApis(query, { limit: 10 });

    if (results.length === 0) {
      console.log(`\n❌ No APIs found matching "${query}"\n`);
      return;
    }

    console.log(`\n✅ Found ${results.length} APIs matching "${query}":\n`);
    console.log('┌────────────────────────────────────────────────┤');

    for (let i = 0; i < results.length; i++) {
      const api = results[i];
      const scorePercent = Math.round(api.score * 100);

      console.log(`│  ${(i + 1)}. ${api.id.padEnd(35)} ${scorePercent}% │`);
      console.log(`│     ${api.category.padEnd(41)} │`);

      // Truncate description to fit
      let desc = api.description;
      if (desc.length > 40) desc = desc.substring(0, 37) + '...';
      console.log(`│     ${desc.padEnd(41)} │`);

      console.log('│                                                │');
    }

    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Get details:                                   │');
    // Show example command for first result
    const firstId = results[0].id;
    // Truncate if too long for display
    const displayId = firstId.length > 30 ? firstId.substring(0, 27) + '...' : firstId;
    console.log(`│   arc --api-info ${displayId}`.padEnd(48) + '│');
    console.log('└────────────────────────────────────────────────┘\n');

  } catch (error) {
    console.error(`\n❌ Failed to search APIs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

async function handleApiInfo(id: string): Promise<void> {
  try {
    const service = new ApiDiscoveryService();
    const api = await service.findApi(id);

    if (!api) {
      console.error(`\n❌ API not found: ${id}\n`);
      process.exit(1);
    }

    console.log('\n┌─ API Details ─────────────────────────────────┐');
    console.log(`│ Name: ${api.name.substring(0, 36)}`.padEnd(48) + '│');
    console.log(`│ ID: ${api.id.substring(0, 38)}`.padEnd(48) + '│');
    console.log(`│ Category: ${api.category.substring(0, 32)}`.padEnd(48) + '│');
    console.log('├────────────────────────────────────────────────┤');

    // Description (multiline handling simplified for CLI)
    console.log('│ Description:                                   │');
    const descLines = api.description.match(/.{1,42}/g) || [];
    for (const line of descLines.slice(0, 3)) {
      console.log(`│   ${line.padEnd(42)} │`);
    }
    if (descLines.length > 3) console.log('│   ...                                          │');

    console.log('├────────────────────────────────────────────────┤');
    console.log(`│ URL: ${api.url.substring(0, 39)}`.padEnd(48) + '│');
    console.log(`│ Auth: ${api.authType}`.padEnd(48) + '│');
    console.log(`│ HTTPS: ${api.https ? 'Yes' : 'No'}`.padEnd(48) + '│');
    console.log(`│ CORS: ${api.cors}`.padEnd(48) + '│');
    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Usage in Workflow:                             │');
    // Updated usage for API
    console.log(`│   prompt: "Use \${apis.${api.id}}..."`.padEnd(48) + '│');
    console.log('└────────────────────────────────────────────────┘\n');
  } catch (error) {
    console.error(`\n❌ Failed to get API info: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}



/**
 * Handle 'arc --list-tools' command
 * Lists all available MCP servers from the catalog
 */
async function handleListTools(): Promise<void> {
  const { ToolDiscoveryService } = await import('./execution/tool-discovery-resolver.js');
  const service = new ToolDiscoveryService();

  try {
    const catalogInfo = await service.getCatalogInfo();
    const catalog = await service.loadCatalog();

    console.log('\n┌─ MCP Servers Catalog ─────────────────────────┐');
    console.log(`│ Total Servers: ${catalogInfo.toolCount.toString().padEnd(31)} │`);
    console.log(`│ Categories: ${catalogInfo.categories.toString().padEnd(34)} │`);
    console.log(`│ Last Updated: ${new Date(catalogInfo.updatedAt).toLocaleDateString().padEnd(30)} │`);
    console.log('├────────────────────────────────────────────────┤');

    // Group by category
    const byCategory = new Map<string, number>();
    for (const tool of catalog.tools) {
      byCategory.set(tool.category, (byCategory.get(tool.category) || 0) + 1);
    }

    // Show top 15 categories
    const topCategories = Array.from(byCategory.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    console.log('│ Top Categories:                                │');
    for (const [category, count] of topCategories) {
      const line = `│   ${category}: ${count}`;
      console.log(line.padEnd(48) + ' │');
    }

    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Usage:                                         │');
    console.log('│   arc --search-tool <query>                    │');
    console.log('│   arc --tool-info <tool-id>                    │');
    console.log('└────────────────────────────────────────────────┘\n');
  } catch (error) {
    console.error(`\n❌ Failed to load MCP catalog: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Handle 'arc --search-tool <query>' command
 * Searches for MCP servers matching the query
 */
async function handleSearchTool(query: string): Promise<void> {
  const { ToolDiscoveryService } = await import('./execution/tool-discovery-resolver.js');
  const service = new ToolDiscoveryService();

  try {
    const results = await service.searchMCPServers(query, { limit: 20 });

    if (results.length === 0) {
      console.log(`\n❌ No MCP servers found matching: "${query}"\n`);
      console.log('💡 Try:');
      console.log('   arc --list-tools          # See all categories');
      console.log('   arc --search-tool browser # Search for browser tools\n');
      return;
    }

    console.log(`\n✅ Found ${results.length} MCP servers matching "${query}":\n`);
    console.log('┌────────────────────────────────────────────────┐');

    results.slice(0, 10).forEach((tool, idx) => {
      const scorePercent = Math.round(tool.score * 100);
      console.log(`│ ${(idx + 1).toString().padStart(2)}. ${tool.name.substring(0, 35).padEnd(35)} ${scorePercent}% │`);
      console.log(`│     ${tool.category.substring(0, 40).padEnd(40)} │`);
      if (tool.description) {
        console.log(`│     ${tool.description.substring(0, 40).padEnd(40)} │`);
      }
      console.log('│                                                │');
    });

    if (results.length > 10) {
      console.log(`│ ... and ${results.length - 10} more results                         │`);
    }

    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Get details:                                   │');
    console.log(`│   arc --tool-info ${results[0].id.substring(0, 28).padEnd(28)} │`);
    console.log('└────────────────────────────────────────────────┘\n');
  } catch (error) {
    console.error(`\n❌ Search failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Handle 'arc --tool-info <id>' command
 * Shows detailed information about a specific MCP server
 */
async function handleToolInfo(toolId: string): Promise<void> {
  const { ToolDiscoveryService } = await import('./execution/tool-discovery-resolver.js');
  const service = new ToolDiscoveryService();

  try {
    const tool = await service.findTool(toolId);

    if (!tool) {
      console.log(`\n❌ MCP server not found: "${toolId}"\n`);
      console.log('💡 Try:');
      console.log(`   arc --search-tool ${toolId}\n`);
      return;
    }

    const availability = await service.checkAvailability(tool);

    console.log('\n┌─ MCP Server Details ──────────────────────────┐');
    console.log(`│ Name: ${tool.name.substring(0, 39).padEnd(39)} │`);
    console.log(`│ ID: ${tool.id.substring(0, 41).padEnd(41)} │`);
    console.log(`│ Category: ${tool.category.substring(0, 35).padEnd(35)} │`);
    console.log('├────────────────────────────────────────────────┤');

    if (tool.description) {
      console.log(`│ Description:                                   │`);
      const words = tool.description.split(' ');
      let line = '';
      for (const word of words) {
        if (line.length + word.length + 1 > 44) {
          console.log(`│   ${line.padEnd(42)} │`);
          line = word;
        } else {
          line += (line ? ' ' : '') + word;
        }
      }
      if (line) {
        console.log(`│   ${line.padEnd(42)} │`);
      }
      console.log('├────────────────────────────────────────────────┤');
    }

    console.log(`│ Repository: ${tool.repositoryUrl.substring(0, 33).padEnd(33)} │`);
    console.log(`│ Languages: ${tool.languages.join(', ').substring(0, 34).padEnd(34)} │`);
    console.log(`│ Scope: ${tool.scope.padEnd(38)} │`);
    console.log(`│ Official: ${(tool.isOfficial ? 'Yes ✓' : 'No').padEnd(35)} │`);

    if (tool.commonEnvVars && tool.commonEnvVars.length > 0) {
      console.log('├────────────────────────────────────────────────┤');
      console.log('│ Required Environment Variables:                │');
      tool.commonEnvVars.forEach(envVar => {
        const status = process.env[envVar] ? '✓' : '✗';
        console.log(`│   ${status} ${envVar.substring(0, 40).padEnd(40)} │`);
      });
    }

    if (availability.missingEnvVars.length > 0) {
      console.log('├────────────────────────────────────────────────┤');
      console.log('│ ⚠️  Missing Environment Variables:              │');
      availability.missingEnvVars.forEach(envVar => {
        console.log(`│   • ${envVar.substring(0, 40).padEnd(40)} │`);
      });
    }

    if (availability.mcpCommand) {
      console.log('├────────────────────────────────────────────────┤');
      console.log('│ Installation:                                  │');
      console.log(`│   ${availability.mcpCommand.substring(0, 42).padEnd(42)} │`);
    }


    console.log('├────────────────────────────────────────────────┤');
    console.log('│ Usage in Workflow:                             │');
    const toolNameLower = tool.name.toLowerCase().substring(0, 20);
    console.log(`│   prompt: "Use \${tools.${toolNameLower}}..."     │`);
    console.log('└────────────────────────────────────────────────┘\n');
  } catch (error) {
    console.error(`\n❌ Failed to get tool info: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Handle 'arc add-api <category>/<name>' command
 */
/**
 * Handle 'arc add-api <api-id>' command
 */
async function handleAddApi(apiId: string): Promise<void> {
  try {
    const service = new ApiDiscoveryService();
    const api = await service.findApi(apiId);

    if (!api) {
      console.log(`\n❌ API not found: ${apiId}\n`);
      await handleListApis();
      return;
    }

    // Import the tool suggestion function
    const { generateStepScaffold } = require('./execution/variable-resolver.js');

    const suggestedTool = {
      id: api.id,
      name: api.name,
      url: api.url,
      confidence: 1.0,
      authType: api.authType,
      category: api.category,
      description: api.description,
    };

    const scaffold = generateStepScaffold(suggestedTool);

    console.log(scaffold);
    console.log('\n📝 Step scaffold copied to clipboard. Paste into your workflow.yaml\n');
  } catch (error) {
    console.error(`\n❌ Error adding API: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Handle orchestrator-based execution (Phase 6c)
 * Uses planning + auto-switch execution
 */
async function handleOrchestratorExecution(
  input: string,
  options: {
    plan: boolean;
    autoSwitch?: boolean | undefined;
    autoApprove?: boolean | undefined;
    executeOnly?: boolean | undefined;
    noSteering?: boolean | undefined;
    timeout?: number | undefined;
    retries?: number | undefined;
    failFast?: boolean | undefined;
    validateOutput?: boolean | undefined;
  }
): Promise<void> {
  const ui = UIManager.getInstance();

  const { loadRuntime } = await import('./tools/runtime.js');
  const runtime = await loadRuntime(process.cwd(), process.env.ARC_RUNTIME_CONFIG);
  const controller = new AbortController();
  const cancel = () => { cancelSanitizedStreams(); controller.abort(new Error('Execution cancelled')); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    // Import Phase 6 components
    const { ArchitectService } = await import('./services/architect-service.js');
    const { PlanConverter } = await import('./parsers/plan-converter.js');
    const { BuilderAgent } = await import('./agents/builder.js');

    // Phase 2: Import orchestration bridge adapter for context conversion
    let bridgeContext;
    try {
      const bridgeModule = await import('./engine/orchestration-bridge.js');
      bridgeContext = bridgeModule;
    } catch {
      // Fallback if bridge not yet created
      bridgeContext = null;
    }

    ui.log('🏗️  Initializing Phase 6c Auto-Switch Orchestrator...');

    // Initialize RAG and Web Scraper (if available)
    let ragContext: any = null;

    try {
      // Try to load RAG knowledge base
      const { SimpleKnowledgeBase } = await import('./rag/simple-knowledge-base.js');
      const kb = new SimpleKnowledgeBase();
      await kb.connect();

      ui.log('🧠 Querying knowledge base for similar workflows...');
      const similarWorkflows = await kb.queryContext(input, {
        limit: 3,
        threshold: 0.3,
        type: 'workflow'
      });

      if (similarWorkflows.length > 0) {
        ui.log(`✅ Found ${similarWorkflows.length} similar workflow(s)`);
        ragContext = {
          similarWorkflows,
          hasContext: true,
          confidence: similarWorkflows[0]?.similarity || 0
        };
      } else {
        ui.log('ℹ️  No similar workflows found in knowledge base');
        ragContext = { similarWorkflows: [], hasContext: false };
      }

      await kb.disconnect();
    } catch (error) {
      ui.log('ℹ️  RAG knowledge base not available (this is optional)');
      ragContext = { similarWorkflows: [], hasContext: false };
    }

    // Try web scraping if enabled and needed
    if (process.env.ENABLE_WEB_SCRAPING === 'true' && process.env.ANTHROPIC_API_KEY?.trim()) {
      try {
        const { ClaudeScraper } = await import('./scraping/claude-scraper.js');
        const scraper = new ClaudeScraper();

        // Check if input mentions a URL or technology that might need docs
        const urlMatch = input.match(/https?:\/\/[^\s]+/);
        const techMatch = input.match(/\b(express|react|next|vue|angular|typescript|python|django|flask)\b/i);

        if (urlMatch) {
          ui.log(`🌐 Scraping documentation from ${urlMatch[0]}...`);
          await scraper.scrapeDocumentation(urlMatch[0], techMatch?.[0] || 'general');
          ui.log('✅ Documentation scraped successfully');
        } else if (techMatch && !ragContext?.hasContext) {
          // Only scrape if we don't have good context from RAG
          ui.log(`🌐 Searching for ${techMatch[0]} documentation...`);
          const docUrl = `https://www.npmjs.com/package/${techMatch[0].toLowerCase()}`;
          try {
            await scraper.scrapeDocumentation(docUrl, techMatch[0]);
            ui.log('✅ Documentation found');
          } catch {
            ui.log('ℹ️  Documentation not found (continuing without it)');
          }
        }
      } catch (error) {
        ui.log('ℹ️  Web scraping not available (this is optional)');
      }
    }

    // Initialize services
    const architectService = new ArchitectService({
      model_tier: 'haiku',
      enable_token_counting: true,
      enable_validation: true,
    }, runtime.registry.catalog());

    // Step 1: Planning Phase (unless --execute-only)
    let plan;
    if (!options.executeOnly) {
      ui.log('📋 Phase A: Planning with Copilot...');
      const architectResponse = await architectService.createPlanFromRequest(input, controller.signal);

      if ('error_code' in architectResponse) {
        ui.error(`Planning failed: ${architectResponse.error_message}`);
        throw new Error('Orchestrator execution failed');
      }

      plan = architectResponse;
      ui.log(`✅ Generated plan with ${plan.steps.length} steps`);
      ui.log(`📊 Estimated tokens: ${plan.estimated_tokens}`);
    }

    // Step 2: Conversion Phase (Moved up to support steering on full workflow)
    let conversionResult;
    let workflow; // Hoisted workflow declaration
    if (plan && !options.executeOnly) {
      ui.log('\n📝 Phase C: Converting plan to workflow...');
      conversionResult = await new PlanConverter(runtime.registry.catalog()).convert(plan);

      if (!conversionResult.success) {
        ui.error('Plan conversion failed');
        throw new Error('Orchestrator execution failed');
      }

      workflow = conversionResult.workflow;
      ui.log(`✅ Converted to ${workflow.steps.length} executable steps`);

      if (conversionResult.hallucinations.length > 0) {
        ui.log(`⚠️  ${conversionResult.hallucinations.length} hallucinations detected and handled`);
      }

      // Step 3: Steering/Approval Phase
      if (!options.autoApprove) {
        const checkpointHandler = new CheckpointHandler({
          show_full_prompts: false,
          show_dependencies: true,
          show_safety_details: true,
        });

        const decision = await checkpointHandler.getApproval(
          workflow,
          conversionResult.hallucinations
        );

        if (!decision.approved) {
          ui.error(`❌ Plan rejected by user: ${decision.user_context || 'No reason provided'}`);
          return;
        }

        workflow = decision.modified_workflow ?? workflow;
        ui.log('✅ Plan approved by user');
      }
    }

    // Phase 2: Initialize bridge context if available
    let bridge;
    if (bridgeContext && bridgeContext.initializeBridgeContext && workflow) {
      bridge = bridgeContext.initializeBridgeContext(workflow, {
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.retries !== undefined ? { retries: options.retries } : {}),
        ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
        ...(options.validateOutput !== undefined ? { validateOutput: options.validateOutput } : {}),
        ...(options.autoApprove !== undefined ? { autoApprove: options.autoApprove } : {}),
        ...(options.noSteering !== undefined ? { noSteering: options.noSteering } : {}),
      });
      ui.log('🌉 Bridge context initialized for execution');
    }

    // Step 4: Execution Phase (Only if workflow exists)
    if (workflow) {
      ui.log('\n⚙️  Phase D: Executing workflow...');
      const builder = new BuilderAgent(runtime.registry);
      const executionResult = await builder.execute(workflow, { permissions: runtime.permissions, approved: true, signal: controller.signal });

      // Phase 2: Convert builder result to execution report using bridge
      if (bridge && bridgeContext && bridgeContext.convertBuilderResultToReport) {
        const report = bridgeContext.convertBuilderResultToReport(workflow, executionResult, bridge);
        ui.log(`\n${bridgeContext.generateExecutionSummary(bridge, executionResult)}`);

        if (!report.success) {
          ui.error(`Execution failed with ${report.stats.failedSteps} error(s)`);
          throw new Error('Orchestrator execution failed');
        }
      } else {
        // Fallback without bridge
        ui.log(`\n✅ Execution complete:`);
        ui.log(`   Status: ${executionResult.status}`);
        ui.log(`   Steps: ${executionResult.summary.successful_steps}/${executionResult.total_steps} successful`);

        if (executionResult.status !== 'success') {
          ui.error(`Execution failed with ${executionResult.summary.failed_steps} error(s)`);
          throw new Error('Orchestrator execution failed');
        }
      }

      // Store workflow results in knowledge base for future learning
      try {
        const { SimpleKnowledgeBase } = await import('./rag/simple-knowledge-base.js');
        const kb = new SimpleKnowledgeBase();
        await kb.connect();

        await kb.addWorkflow(input, {
          success: executionResult.status === 'success',
          stats: {
            totalSteps: executionResult.total_steps,
            successfulSteps: executionResult.summary.successful_steps,
            failedSteps: executionResult.summary.failed_steps
          },
          executionTime: 0,
          errors: []
        });

        ui.log('💾 Workflow results stored in knowledge base');
        await kb.disconnect();
      } catch (error) {
        // Non-critical, just log
        ui.log('ℹ️  Could not store results in knowledge base (this is optional)');
      }
    }

    // Handle execute-only mode where no plan was provided via this path
    if (options.executeOnly) {
      ui.log('⚠️  Skipping planning phase (--execute-only specified)');
      ui.error('❌ Orchestrator mode requires a plan to execute');
      throw new Error('Orchestrator execution failed');
    }

  } catch (error) {
    const ui = UIManager.getInstance();
    ui.error(`Orchestrator execution failed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.DEBUG) {
      console.error(error);
    }
    throw new Error('Orchestrator execution failed');
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await runtime.close();
  }
}

/**
 * Detect if input is a workflow file or a prompt string
 * Returns { isFile: boolean, path?: string, prompt?: string }
 */
function detectInputType(input: string): { isFile: boolean; path?: string; prompt?: string } {
  // Check if it looks like a file path
  if (
    input.endsWith('.yaml') ||
    input.endsWith('.yml') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('/')
  ) {
    return { isFile: true, path: input };
  }

  // Otherwise treat as prompt string
  return { isFile: false, prompt: input };
}

/**
 * Primary Application Entry Point.
 * Orchestrates the full lifecycle of the ARC CLI:
 * 1. Environment and Authorization Pre-flight.
 * 2. Multi-mode argument parsing (Workflow vs Prompt).
 * 3. Planning Phase (Architect Agent) instantiation.
 * 4. Execution Phase (Builder Agent) orchestration.
 * 5. Telemetry aggregation and process exit management.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2); // Skip 'bun' and script path

  // Parse arguments
  const parsed = parseArgs(args);

  // Handle help flag
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  // Handle version flag
  if (parsed.version) {
    printVersion();
    process.exit(0);
  }

  // Handle check-auth flag
  if (parsed.checkAuth) {
    try {
      const authStatus = verifyGithubCopilotAuth();
      console.log(`\n✅ GitHub Copilot CLI authenticated as @${authStatus.user}`);
      console.log(`   Version: ${authStatus.version}`);
      console.log(`   Hostname: ${authStatus.hostname}`);
      console.log(`   Scopes: ${authStatus.scope.join(', ')}\n`);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Authentication check failed:\n`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle add-api list-categories command
  if (parsed.listCategories) {
    try {
      await handleListApis();
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle add-api search command
  if (parsed.search) {
    try {
      await handleSearchApi(parsed.search);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle tool discovery: --list-tools
  if (parsed.listTools) {
    try {
      await handleListTools();
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle tool discovery: --search-tool <query>
  if (parsed.searchTool) {
    try {
      await handleSearchTool(parsed.searchTool);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle API discovery: --list-apis
  if (parsed.listApis) {
    try {
      await handleListApis();
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle API discovery: --search-api <query>
  if (parsed.searchApi) {
    try {
      await handleSearchApi(parsed.searchApi);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle API discovery: --api-info <id>
  if (parsed.apiInfo) {
    try {
      await handleApiInfo(parsed.apiInfo);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
  if (parsed.toolInfo) {
    try {
      await handleToolInfo(parsed.toolInfo);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle parsing errors
  if (parsed.error) {
    console.error(`❌ Error: ${parsed.error}\n`);
    printUsage();
    process.exit(1);
  }

  // Handle add-api command with category/name argument
  if (parsed.command === 'add-api') {
    try {
      if (!parsed.argument) {
        console.error('❌ Error: API ID required\n');
        await handleListApis();
        process.exit(1);
      }
      await handleAddApi(parsed.argument);
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  // Handle init command
  if (parsed.command === 'init') {
    if (!parsed.argument) {
      console.error('❌ Error: Project name is required for init command\n');
      printUsage();
      process.exit(1);
    }
    await handleInitCommand(parsed.argument, {
      skipReadme: parsed.skipReadme || false,
      skipEnv: parsed.skipEnv || false,
      withCI: parsed.withCI || false,
    });
    process.exit(0);
  }

  // Handle connect command
  if (parsed.command === 'connect') {
    if (!parsed.argument) {
      console.error('❌ Error: Tool name is required for connect command\n');
      console.error('Usage: arc connect <tool-name>\n');
      console.error('Example: arc connect figma\n');
      process.exit(1);
    }
    await handleConnectCommand(parsed.argument, {});
    process.exit(0);
  }

  // Otherwise, treat first argument as workflow file
  const workflowFile = parsed.command || parsed.argument;
  if (!workflowFile) {
    console.error('❌ Error: Workflow file or command is required\n');
    printUsage();
    process.exit(1);
  }

  // Phase 6c: Check if using orchestrator mode (with --plan flag)
  if (parsed.plan || parsed.autoSwitch) {
    // Treat input as prompt string for orchestrator
    await handleOrchestratorExecution(workflowFile, {
      plan: parsed.plan ?? false,
      autoSwitch: parsed.autoSwitch,
      autoApprove: parsed.autoApprove,
      executeOnly: parsed.executeOnly,
      noSteering: parsed.noSteering,
      timeout: parsed.timeout,
      retries: parsed.retries,
      failFast: parsed.failFast,
      validateOutput: parsed.validateOutput,
    });
    process.exit(0);
  }

  // Traditional mode: Load and execute workflow file
  const controller = new AbortController();
  const cancel = () => { cancelSanitizedStreams(); controller.abort(new Error('Execution cancelled')); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    // Detect if input is a file or prompt
    const inputType = detectInputType(workflowFile);

    if (!inputType.isFile) {
      console.error('❌ Error: Prompt string detected but no --plan flag provided');
      console.error('   Use: arc "<prompt>" --plan [--auto-switch] [--auto-approve]');
      process.exit(1);
    }

    // Resolve workflow file path
    const workflowPath = resolve(inputType.path!);

    // Load and parse the workflow
    console.log(`📂 Loading workflow from: ${workflowPath}`);
    const workflow = await loadWorkflowFromFile(workflowPath);

    // Pre-flight validation
    const validation = validateWorkflowBeforeExecution(workflow);
    if (!validation.valid) {
      console.error('\n❌ Workflow validation failed:');
      for (const error of validation.errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }

    // Execute the workflow with logging
    const report = await executeWorkflowWithLogging(workflow, {
      signal: controller.signal,
      ...(parsed.timeout !== undefined && { timeout: parsed.timeout }),
      ...(parsed.retries !== undefined && { retries: parsed.retries }),
      ...(parsed.failFast !== undefined && { failFast: parsed.failFast }),
      ...(parsed.validateOutput !== undefined && { validateOutput: parsed.validateOutput }),
    });

    // Exit with appropriate code
    process.exit(report.success ? 0 : 1);
  } catch (error) {
    // Handle workflow loading errors
    if (error instanceof WorkflowParseError) {
      console.error(`\n❌ Workflow Parse Error`);
      console.error(`   File: ${error.filePath}`);
      console.error(`   ${error.message}`);
      if (error.details) {
        console.error(`\n   Details:\n${error.details}`);
      }
    } else {
      console.error(`\n❌ Unexpected Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    process.exit(1);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
