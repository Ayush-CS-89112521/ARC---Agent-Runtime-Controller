import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Ajv } from 'ajv';
import { z } from 'zod';
import { ExecutableRegistry } from './executable-registry.js';

/** A trusted configuration supplies the process; model output never supplies executable commands. */
export async function connectMcpServer(registry: ExecutableRegistry, config: {
  id: string; command: string; args: string[]; allowedTools: string[];
}): Promise<() => Promise<void>> {
  const client = new Client({ name: 'arc', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, stderr: 'pipe' });
  transport.stderr?.on('data', () => { /* drain untrusted diagnostics without logging credentials */ });
  try {
    await client.connect(transport, { timeout: 10000 });
    const ajv = new Ajv({ strict: false, allErrors: true });
    let cursor: string | undefined;
    const pending = [];
    const cursors = new Set<string>();
    do {
      if (cursor) { if (cursors.has(cursor) || cursors.size >= 100) throw new Error('Invalid MCP pagination'); cursors.add(cursor); }
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
      pending.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    for (const tool of pending) {
      if (!config.allowedTools.includes(tool.name)) continue;
      const validateInput = ajv.compile(tool.inputSchema);
      const validateOutput = tool.outputSchema ? ajv.compile(tool.outputSchema) : undefined;
      registry.register({ id: `${config.id}.${tool.name}`, name: tool.name,
        description: tool.description ?? tool.name, permission: `mcp:${config.id}:${tool.name}`, requiresApproval: true,
        input: z.unknown().refine(value => validateInput(value), 'Invalid MCP tool arguments'),
        output: z.unknown(),
        execute: async (input, context) => {
          const args = z.record(z.string(), z.unknown()).parse(input);
          const result = await client.callTool({ name: tool.name, arguments: args }, undefined,
            { signal: context.signal, timeout: context.timeoutMs });
          if (result.isError) throw new Error(`MCP tool failed: ${tool.name}`);
          if (validateOutput && !validateOutput(result.structuredContent)) throw new Error('Invalid MCP output schema');
          return result;
        },
      });
    }
    return () => client.close();
  } catch (error) {
    await client.close();
    throw error;
  }
}
