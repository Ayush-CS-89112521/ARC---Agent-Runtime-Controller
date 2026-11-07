import { ZodError } from "zod";
import type { AnyDevTool, Risk } from "./types.js";
import { sanitize } from "./sanitizer.js";

export type RunMode = "dry-run" | "execute";

export type RunOutcome =
  | { ok: true; toolId: string; mode: RunMode; risk: Risk; result: unknown }
  | { ok: false; toolId: string; mode: RunMode; error: string };

export class ToolRegistry {
  private tools = new Map<string, AnyDevTool>();

  register(tool: AnyDevTool): this {
    if (this.tools.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    this.tools.set(tool.id, tool);
    return this;
  }

  get(id: string): AnyDevTool | undefined {
    return this.tools.get(id);
  }

  list(): AnyDevTool[] {
    return [...this.tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Validate -> (dry-run | execute). Execution of medium/high risk tools
   * requires `confirmed: true`, so the CLI can't run them by accident.
   */
  async run(
    id: string,
    rawInput: unknown,
    opts: { mode: RunMode; confirmed?: boolean },
  ): Promise<RunOutcome> {
    const tool = this.tools.get(id);
    if (!tool) {
      return { ok: false, toolId: id, mode: opts.mode, error: `Unknown tool '${id}'` };
    }

    const parsed = tool.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { ok: false, toolId: id, mode: opts.mode, error: formatZod(parsed.error) };
    }

    try {
      if (opts.mode === "dry-run") {
        const preview = await tool.dryRun(parsed.data);
        return { ok: true, toolId: id, mode: "dry-run", risk: tool.risk, result: preview };
      }

      if (tool.risk !== "low" && !opts.confirmed) {
        return {
          ok: false,
          toolId: id,
          mode: "execute",
          error: `'${id}' is ${tool.risk}-risk. Re-run with --yes to confirm (preview with --dry-run first).`,
        };
      }

      const result = await tool.execute(parsed.data);
      return { ok: true, toolId: id, mode: "execute", risk: tool.risk, result };
    } catch (e) {
      // Sanitize error text too: thrown messages can embed command output.
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, toolId: id, mode: opts.mode, error: sanitize(msg) };
    }
  }
}

function formatZod(err: ZodError): string {
  return (
    "Invalid input: " +
    err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
  );
}
