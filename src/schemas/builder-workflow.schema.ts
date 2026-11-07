import { z } from 'zod';

/** Validate the execution-critical Builder contract independently of YAML/Copilot steps. */
export const BuilderWorkflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), prompt: z.string(),
    tools: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()).length(1),
    input: z.unknown().optional(), when: z.string().optional(),
    safety: z.object({ timeout: z.number().int().positive(),
      pattern_scan: z.boolean().optional(), require_approval: z.boolean().optional() }).passthrough(),
    error_handling: z.object({ on_failure: z.enum(['stop_workflow', 'skip_step', 'retry']) }).passthrough(),
  }).passthrough()),
}).passthrough();
