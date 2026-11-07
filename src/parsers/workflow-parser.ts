/**
 * Workflow Parser - Loads and validates YAML workflow files
 * Integrates Zod schema validation with YAML parsing
 */

import { parse as parseYaml } from 'yaml';
import { validateWorkflowSafe } from '../schemas/workflow.schema.js';
import { validateDependencyOrder } from '../execution/variable-resolver.js';
import { Workflow } from '../types/index.js';
import { readFile } from 'node:fs/promises';

/**
 * Error thrown when YAML parsing or validation fails
 */
export class WorkflowParseError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

/**
 * Parse a YAML string into a Workflow object
 * Performs both YAML parsing and Zod schema validation
 *
 * @param yamlContent - The raw YAML content as a string
 * @param filePath - The file path (used in error messages)
 * @returns A validated Workflow object
 * @throws WorkflowParseError if YAML parsing or schema validation fails
 */
export function parseWorkflowFromYaml(yamlContent: string, filePath: string): Workflow {
  let parsed: unknown;

  // Step 1: Parse YAML
  try {
    parsed = parseYaml(yamlContent);
  } catch (error) {
    throw new WorkflowParseError(
      `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
      filePath
    );
  }

  // Step 2: Validate against Zod schema
  const validation = validateWorkflowSafe(parsed);
  if (!validation.success) {
    const errorMessages = validation.error.issues
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');

    throw new WorkflowParseError(
      `Schema validation failed:\n${errorMessages}`,
      filePath,
      validation.error.toString()
    );
  }

  const workflow = validation.data as Workflow;

  if (new Set(workflow.steps.map(step => step.id)).size !== workflow.steps.length) {
    throw new WorkflowParseError('Duplicate step IDs are not allowed', filePath);
  }

  // Step 3: Validate dependency order (catch forward references early)
  try {
    validateDependencyOrder(workflow.steps);
  } catch (error) {
    throw new WorkflowParseError(
      `Dependency validation failed: ${error instanceof Error ? error.message : String(error)}`,
      filePath
    );
  }

  return workflow;
}

/**
 * Load and parse a workflow from a file path
 * Reads the file and delegates to parseWorkflowFromYaml
 *
 * @param filePath - The path to the YAML workflow file
 * @returns A validated Workflow object
 * @throws WorkflowParseError if file reading or parsing fails
 */
export async function loadWorkflowFromFile(filePath: string): Promise<Workflow> {
  try {
    const yamlContent = await readFile(filePath, 'utf8');
    return parseWorkflowFromYaml(yamlContent, filePath);
  } catch (error) {
    if (error instanceof WorkflowParseError) {
      throw error;
    }
    throw new WorkflowParseError(
      `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      filePath
    );
  }
}

/**
 * Validate a workflow object and return detailed error information
 * Useful for testing and validation without throwing
 *
 * @param yamlContent - The raw YAML content as a string
 * @param filePath - The file path (used in error messages)
 * @returns An object with success status and either the workflow or error details
 */
export function validateWorkflowSafely(
  yamlContent: string,
  filePath: string
): { success: boolean; workflow?: Workflow; error?: string } {
  try {
    const workflow = parseWorkflowFromYaml(yamlContent, filePath);
    return { success: true, workflow };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof WorkflowParseError
          ? `${error.message}\nFile: ${error.filePath}`
          : String(error),
    };
  }
}
