/**
 * Agent Runtime Controller - Core Type Definitions
 * Optimized for TypeScript 5.x and Bun
 */

/**
 * GitHub authentication status
 */
export interface GithubAuthStatus {
  isAuthenticated: boolean;
  user: string;
  version: string;
  scope: string[];
  hostname: string;
}

/**
 * Output configuration for a step result
 * Defines how the step's output should be stored
 */
export interface StepOutputConfig {
  type: 'file' | 'files' | 'variable';
  /** Variable name to store output under (used when type='variable') */
  name?: string;
  /** File path pattern (used when type='file' or 'files') */
  path?: string;
  /** Whether to merge with existing variable or replace */
  merge?: boolean;
}

/**
 * Represents a single executable step in a workflow
 */
export interface WorkflowStep {
  /** Unique identifier within the workflow */
  id: string;
  /** Display name for the step */
  name?: string;
  /** Agent to use (e.g., 'suggest', 'explain') */
  agent: string;
  /** Prompt/input to send to the agent */
  prompt: string;
  /** Output configuration for this step's results */
  output: StepOutputConfig;
  /** Optional timeout in milliseconds (overrides workflow config) */
  timeout?: number;
  /** Optional max retries (overrides workflow config) */
  retries?: number;
  /** Optional conditional expression - step executes only if this evaluates to true */
  when?: string;
  /** Optional step-specific metadata */
  metadata?: Record<string, unknown>;
  /** Optional step-level safety policy override */
  safety?: SafetyPolicy;
  /** Optional resource limits for this step */
  resources?: StepResourceLimits;
  /** Requested Copilot model tier */
  model?: 'haiku' | 'sonnet';
  /** Enable output summarization for large outputs (>5KB). Default: true */
  compress?: boolean;
  /** Enable response caching for deterministic steps. Default: true */
  cache?: boolean;
  /** Maximum output size in bytes before auto-truncation. Default: unlimited */
  maxOutputSize?: number;
}

/**
 * Represents a complete workflow definition
 */
export interface Workflow {
  /** Workflow metadata */
  version: string;
  name: string;
  description?: string;
  /** Array of steps to execute in order */
  steps: WorkflowStep[];
  /** Global configuration (can be overridden per-step) */
  config?: WorkflowConfig;
  /** Workflow-level metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Global configuration for workflow execution
 */
export interface WorkflowConfig {
  /** Default timeout per step in milliseconds */
  timeout: number;
  /** Default number of retries on failure */
  retries: number;
  /** Whether to stop on first failure */
  failFast?: boolean;
  /** Whether to validate outputs against schema */
  validateOutput?: boolean;
  /** Optional workflow-level safety policy */
  safety?: SafetyPolicy;
  /** Resource limits for workflow execution */
  resources?: WorkflowResourceLimits;
  /** Optional token budget limit for workflow */
  tokenBudget?: number;
  /** Cost optimization level: 'min' (aggressive compression), 'balanced' (default), 'quality' (no compression) */
  costTarget?: 'min' | 'balanced' | 'quality';
}

/**
 * Resource limits for the entire workflow
 */
export interface WorkflowResourceLimits {
  /** Global maximum duration for entire workflow in milliseconds (default: 1800000 = 30 min) */
  maxDurationMs?: number;
  /** Default per-step memory limit in MB (default: 512) */
  defaultMemoryMB?: number;
  /** Default CPU usage threshold % (warning at this level, default: 80) */
  defaultCpuWarnPercent?: number;
}

/**
 * Resource limits for a specific step
 */
export interface StepResourceLimits {
  /** Per-step memory limit in MB (overrides workflow default) */
  memoryMB?: number;
  /** CPU usage warning threshold % for this step */
  cpuWarnPercent?: number;
}

/**
 * Result from executing a single step
 */
export interface StepResult {
  /** Step ID that was executed */
  stepId: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Raw output from the agent */
  output: string;
  /** Parsed/processed output (if applicable) */
  parsedOutput?: unknown;
  /** Duration in milliseconds */
  duration: number;
  /** Error message if failed */
  error?: string;
  /** Execution timestamp */
  timestamp: Date;
  /** Number of retries attempted */
  retriesAttempted: number;
  /** Legacy persisted model tier. */
  requestedModelTier?: 'haiku' | 'sonnet';
  reportedModels?: string[];
  /** Counters supplied by the CLI. Credits and request units are not currency. */
  copilotUsage?: { totalPremiumRequestCost?: number; totalNanoAiu?: number };
  model?: 'haiku' | 'sonnet';
  /** Estimated token count for this step's prompt and output */
  tokenEstimate?: number;
}

/**
 * Result from executing a single step (extended with safety info)
 */
export interface StepResultWithSafety extends StepResult {
  /** Safety scan result for this step */
  safetyCheck?: SafetyScanResult;
  /** Whether safety checks passed before variable persistence */
  safetyChecksPassed?: boolean;
}

/**
 * Execution context - manages state and variables across steps
 */
export interface ExecutionContext {
  /** Unique identifier for this workflow execution */
  runId: string;
  /** Map of variable names to their values (step outputs) */
  variables: Map<string, unknown>;
  /** Step results history */
  results: StepResult[];
  /** Safety scan results for audit trail */
  safetyScans?: SafetyScanResult[];
  /** Execution configuration */
  config: WorkflowConfig;
  /** Execution start time */
  startTime: Date;
  /** Execution end time (set after completion) */
  endTime?: Date;
  /** Current step being executed (for error context) */
  currentStepId?: string;
  /** Metadata about the execution */
  metadata?: Record<string, unknown>;
  /** Skipped steps due to failed conditions */
  skippedSteps?: SkippedStepRecord[];
  /** Resource watchdog alerts during execution */
  resourceAlerts?: ResourceAlert[];
  /** GitHub authentication status (set at workflow start) */
  githubAuth?: GithubAuthStatus;
  /** Tool metadata discovered from MCP registry (populated by tool discovery resolver) */
  toolMetadata?: Map<string, any>;
  /** Prompt/input for current step (for tool discovery context) */
  prompt?: string;
  /** Execution flags for Phase 5 features */
  flags?: ExecutionFlags;
}

/**
 * Execution flags for controlling workflow behavior
 */
export interface ExecutionFlags {
  /** Step-by-step execution mode: pause before every tool call */
  stepMode?: boolean;
  /** Allow pushes to main/master branches */
  allowMainPush?: boolean;
  /** Enable context injection for trajectory correction */
  enableContextInjection?: boolean;
}

/**
 * Variable reference for resolving step outputs in prompts
 * Supports patterns like: ${steps.step1.output} or ${steps.step1.output.field}
 */
export interface VariableReference {
  /** Full reference string (e.g., 'steps.step1.output') */
  reference: string;
  /** Parsed parts of the reference */
  path: string[];
  /** Original text position in source */
  position?: {
    start: number;
    end: number;
  };
}

/**
 * Safety violation detected in step output
 */
export interface SafetyViolation {
  /** Category of violation (destructive, exfiltration, privilege, filesystem) */
  category: 'destructive' | 'exfiltration' | 'privilege' | 'filesystem' | 'custom';
  /** Severity level */
  severity: 'warn' | 'pause' | 'block';
  /** Pattern that triggered the violation */
  pattern: string;
  /** Matched text from output */
  match: string;
  /** Line number where match occurred */
  line: number;
  /** Confidence score (0-1) */
  confidence: number;
  /** Remediation suggestion for user */
  remediation: string;
  /** Timestamp of detection */
  timestamp: Date;
  /** User decision if pause-level: 'allow', 'deny', 'inspect' */
  userDecision?: 'allow' | 'deny' | 'inspect';
}

/**
 * Result from scanning step output for safety violations
 */
export interface SafetyScanResult {
  /** Step ID that was scanned */
  stepId: string;
  /** Whether scan completed */
  scanCompleted: boolean;
  /** Array of violations found */
  violations: SafetyViolation[];
  /** Overall status */
  status: 'safe' | 'warning' | 'paused' | 'blocked';
  /** Timestamp of scan */
  timestamp: Date;
  /** Duration of scan in milliseconds */
  duration: number;
}

/**
 * Safety policy configuration per workflow or step
 */
export interface SafetyPolicy {
  /** Enable/disable safety checks */
  enabled: boolean;
  /** Handling mode: warn (log), pause (prompt user), block (fail immediately) */
  mode: 'warn' | 'pause' | 'block';
  /** Pattern categories to check (can disable specific categories) */
  categories: {
    destructive?: boolean;
    exfiltration?: boolean;
    privilege?: boolean;
    filesystem?: boolean;
  };
  /** Regex patterns to block (custom rules) */
  blockPatterns?: string[];
  /** Regex patterns to allow (whitelist) */
  allowPatterns?: string[];
  /** Confidence threshold (0-1) for triggering violations */
  confidenceThreshold?: number;
}

/**
 * Result of evaluating a conditional expression for a step
 */
export interface ConditionEvaluationResult {
  /** The condition expression that was evaluated */
  condition: string;
  /** Whether the condition evaluated to true */
  evaluated: boolean;
  /** Context values used in evaluation (for audit trail) */
  context: Record<string, unknown>;
  /** Timestamp of evaluation */
  timestamp: Date;
  /** Any error during evaluation (e.g., syntax error) */
  error?: string;
}

/**
 * Record of a step that was skipped due to condition
 */
export interface SkippedStepRecord {
  /** Step ID that was skipped */
  stepId: string;
  /** Condition that evaluated to false */
  condition: string;
  /** Timestamp of skip */
  timestamp: Date;
  /** Reason message for user */
  reason: string;
}

/**
 * Resource alert from watchdog monitoring
 */
export interface ResourceAlert {
  /** Step ID being monitored when alert occurred */
  stepId: string;
  /** Type of alert: memory, cpu, or process_killed */
  alertType: 'memory' | 'cpu' | 'process_killed';
  /** Actual value that triggered alert */
  actualValue: number;
  /** Limit that was breached */
  limitValue: number;
  /** Unit of measurement (MB, %, ms, etc) */
  unit: string;
  /** Timestamp of alert */
  timestamp: Date;
  /** Detailed message */
  message: string;
  /** Process ID that was monitored */
  pid?: number;
  /** Last output before termination (if killed) */
  lastOutput?: string;
}

/**
 * Metrics snapshot from process monitoring
 */
export interface ProcessMetrics {
  /** Process ID */
  pid: number;
  /** Memory usage in MB (RSS - resident set size) */
  memoryMB: number;
  /** CPU usage percentage (0-100) */
  cpuPercent: number;
  /** Timestamp of measurement */
  timestamp: Date;
}

/**
 * Extended workflow configuration with safety options
 */
export interface WorkflowConfigWithSafety extends WorkflowConfig {
  /** Safety policy for this workflow */
  safety?: SafetyPolicy;
}

/**
 * Final workflow execution report
 */
export interface ExecutionReport<W = Workflow> {
  /** Workflow that was executed */
  workflow: W;
  /** Execution context at completion */
  context: ExecutionContext;
  /** Overall success status */
  success: boolean;
  /** Aggregated error messages if any step failed */
  errors: string[];
  /** Total duration in milliseconds */
  totalDuration: number;
  /** Summary statistics */
  stats: {
    totalSteps: number;
    successfulSteps: number;
    failedSteps: number;
  };
  /** Safety scan results for all steps */
  safetyScans?: SafetyScanResult[];
}

/**
 * Workflow execution result for RAG storage
 */
export interface WorkflowExecutionResult {
  /** Whether the workflow executed successfully */
  success: boolean;
  /** Execution statistics */
  stats?: {
    totalSteps: number;
    successfulSteps: number;
    failedSteps: number;
  };
  /** Total execution time in milliseconds */
  executionTime?: number;
  /** Array of errors encountered */
  errors?: Array<{ message: string; step?: string }>;
  /** Summary of execution */
  summary?: string;
}

