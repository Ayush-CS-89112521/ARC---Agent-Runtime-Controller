import { z } from 'zod';

export interface Invocation {
  permissions: ReadonlySet<string>;
  approved: boolean;
  signal: AbortSignal;
  timeoutMs: number;
  operationId?: string;
}

export interface ExecutableTool {
  id: string;
  name: string;
  description: string;
  permission: string;
  requiresApproval: boolean;
  input: z.ZodType<unknown>;
  output: z.ZodType<unknown>;
  execute(input: unknown, context: Invocation): Promise<unknown>;
}

/** The only executable entry point. Discovery metadata is never executable. */
export class ExecutableRegistry {
  private readonly tools = new Map<string, ExecutableTool>();

  register(tool: ExecutableTool): this {
    if (!tool.id || !tool.permission || !tool.input || !tool.output || typeof tool.execute !== 'function') {
      throw new Error('Invalid executable tool registration');
    }
    if (this.tools.has(tool.id)) throw new Error(`Duplicate tool: ${tool.id}`);
    this.tools.set(tool.id, tool);
    return this;
  }

  catalog() {
    return [...this.tools.values()].map(tool => ({ id: tool.id, name: tool.name,
      description: tool.description, category: 'runtime', authType: 'none' as const,
      scope: tool.requiresApproval ? 'modify' as const : 'read-only' as const }));
  }

  async invoke(id: string, input: unknown, context: Invocation): Promise<unknown> {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Tool '${id}' is not registered`);
    const parsed = tool.input.parse(input);
    // Check current grants on every invocation; do not cache authorization.
    if (!context.permissions.has(tool.permission)) throw new Error(`Permission denied: ${tool.permission}`);
    if (tool.requiresApproval && !context.approved) throw new Error(`Approval required: ${id}`);
    context.signal.throwIfAborted();
    if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) throw new Error('Invalid tool timeout');
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason ?? new Error('Execution cancelled'));
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Tool timeout after ${context.timeoutMs}ms`)), context.timeoutMs);
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([tool.execute(parsed, { ...context, signal: controller.signal }), cancelled]);
      controller.signal.throwIfAborted();
      return tool.output.parse(result);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
