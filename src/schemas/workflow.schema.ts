/**
 * Agent Runtime Controller - Zod Schema Definitions
 * Runtime validation that ensures YAML files match the TypeScript interfaces
 * Optimized for TypeScript 5.x and Bun
 */

import { z } from 'zod';

/**
 * Valid GitHub Copilot agents
 * Expandable list of supported agents
 */
const COPILOT_AGENTS = ['suggest', 'explain', 'edit'] as const;

/**
 * Schema for StepOutputConfig
 * Validates output configuration with refinement logic
 */
const StepOutputConfigSchema = z
  .object({
    type: z.enum(['file', 'files', 'variable']),
    name: z.string().min(1).optional(),
    path: z.string().optional(),
    merge: z.boolean().optional(),
  })
  .refine(
    (data) => {
      // If type is 'variable', name MUST be present and non-empty
      if (data.type === 'file' && !data.path?.trim()) return false;
      if (data.type === 'variable' && !data.name) {
        return false;
      }
      return true;
    },
    {
      message: "Variable outputs require a name and file outputs require a path",
      path: ['name'],
    }
  );

/**
 * Schema for SafetyPolicy
 * Validates safety configuration for workflows or steps
 */
const SafetyPolicySchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['warn', 'pause', 'block']).default('warn'),
  categories: z
    .object({
      destructive: z.boolean().optional(),
      exfiltration: z.boolean().optional(),
      privilege: z.boolean().optional(),
      filesystem: z.boolean().optional(),
    })
    .optional(),
  blockPatterns: z.array(z.string()).optional(),
  allowPatterns: z.array(z.string()).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

/**
 * Schema for resource limits
 */
const StepResourceLimitsSchema = z.object({
  memoryMB: z.number().int().positive().optional(),
  cpuWarnPercent: z.number().int().min(0).max(100).optional(),
});

const WorkflowResourceLimitsSchema = z.object({
  maxDurationMs: z.number().int().positive().optional(),
  defaultMemoryMB: z.number().int().positive().optional(),
  defaultCpuWarnPercent: z.number().int().min(0).max(100).optional(),
});

/**
 * Schema for WorkflowStep (extended with safety)
 * Validates individual workflow steps with agent, prompt, and optional safety constraints
 */
const WorkflowStepSchemaWithSafety = z
  .object({
    id: z.string().min(1, 'Step id must be a non-empty string'),
    name: z.string().optional(),
    agent: z
      .string()
      .min(1, 'Agent must be a non-empty string')
      .refine(
        (agent) => COPILOT_AGENTS.includes(agent as typeof COPILOT_AGENTS[number]),
        {
          message: `Agent must be one of: ${COPILOT_AGENTS.join(', ')}`,
        }
      ),
    model: z.enum(['haiku', 'sonnet']).optional(),
    prompt: z.string().min(1, 'Prompt must be a non-empty string'),
    output: StepOutputConfigSchema,
    timeout: z.number().int().positive().optional(),
    retries: z.number().int().nonnegative().optional(),
    when: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    safety: SafetyPolicySchema.optional(),
    resources: StepResourceLimitsSchema.optional(),
  })
  .refine(
    (step) => {
      // Detect variable references in prompt for informational purposes
      const matches = step.prompt.match(VARIABLE_REFERENCE_PATTERN);
      if (matches) {
        // This is just a detection flag; validation passes but engine will resolve later
        step.metadata = step.metadata || {};
        step.metadata._detectedVariables = matches;
      }
      return true;
    },
    {
      message: 'Failed to process prompt variables',
    }
  );

/**
 * Schema for WorkflowConfig (extended with safety)
 * Validates global workflow configuration with optional safety policy
 */
const WorkflowConfigSchemaWithSafety = z
  .object({
    timeout: z.number().int().positive('Timeout must be a positive integer'),
    retries: z.number().int().nonnegative('Retries must be non-negative'),
    failFast: z.boolean().optional(),
    validateOutput: z.boolean().optional(),
    safety: SafetyPolicySchema.optional(),
    resources: WorkflowResourceLimitsSchema.optional(),
  })
  .strict();

/**
 * Schema for Workflow (extended with safety)
 * Top-level schema that validates entire workflow structure with safety support
 */
const WorkflowSchemaWithSafety = z.object({
  version: z.string().min(1, 'Version must be a non-empty string'),
  name: z.string().min(1, 'Workflow name must be a non-empty string'),
  description: z.string().optional(),
  steps: z.array(WorkflowStepSchemaWithSafety).min(1, 'Workflow must have at least one step'),
  config: WorkflowConfigSchemaWithSafety.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Type inference from the Zod schemas
 * This demonstrates how the TypeScript type can be derived from the schema
 * Keeping manual types in src/types/index.ts for now for explicit control
 */
export type ValidatedWorkflow = z.infer<typeof WorkflowSchemaWithSafety>;
export type ValidatedWorkflowStep = z.infer<typeof WorkflowStepSchemaWithSafety>;
export type ValidatedStepOutputConfig = z.infer<typeof StepOutputConfigSchema>;
export type ValidatedWorkflowConfig = z.infer<typeof WorkflowConfigSchemaWithSafety>;
export type ValidatedSafetyPolicy = z.infer<typeof SafetyPolicySchema>;

/**
 * Export individual schemas for composed validation
 * WorkflowSchema, WorkflowStepSchema, and WorkflowConfigSchema now include safety support
 */
export const WorkflowSchema = WorkflowSchemaWithSafety;
export const WorkflowStepSchema = WorkflowStepSchemaWithSafety;
export const WorkflowConfigSchema = WorkflowConfigSchemaWithSafety;

/**
 * Regex pattern to detect variable references in prompts
 * Matches: ${steps.stepId.output}, ${steps.stepId.output.field}, etc.
 */
export const VARIABLE_REFERENCE_PATTERN = /\$\{[^}]+\}/g;

export {
  StepOutputConfigSchema,
  SafetyPolicySchema,
  COPILOT_AGENTS,
};

/**
 * Main validation function - validates raw YAML data against the schema
 * Returns either the validated Workflow or throws a ZodError
 * Usage: const workflow = validateWorkflow(parsedYamlData);
 */
export function validateWorkflow(data: unknown) {
  return WorkflowSchema.parse(data);
}

/**
 * Safe validation function - returns either the validated workflow or error details
 * Usage: const result = validateWorkflowSafe(parsedYamlData);
 *        if (!result.success) console.error(result.error.issues);
 */
export function validateWorkflowSafe(data: unknown) {
  return WorkflowSchema.safeParse(data);
}
