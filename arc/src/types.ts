import type { ZodType } from "zod";

export type Risk = "low" | "medium" | "high";

/**
 * The contract every tool implements.
 * TInput is the *parsed* input type (after Zod defaults are applied).
 */
export interface DevTool<TInput, TOutput> {
  /** Namespaced id, e.g. 'git.safe_branch'. */
  readonly id: string;
  /** One-line description. */
  readonly description: string;
  /** Input validation. Output type is TInput; raw input is unknown. */
  readonly schema: ZodType<TInput, unknown>;
  readonly risk: Risk;
  /** Exact commands shown in dry-run and confirmation guard cards. */
  readonly commands?: string[] | ((input: TInput) => string[]);
  /** Plain-English preview. Must NOT mutate the system. */
  dryRun(input: TInput): Promise<string>;
  /** Performs the operation. */
  execute(input: TInput): Promise<TOutput>;
  /** Custom UI formatting for live terminal execution. */
  formatResult?(output: TOutput): { warning?: string; details?: string[] };
}

/** Erased form used by the registry. */
export type AnyDevTool = DevTool<any, any>;
