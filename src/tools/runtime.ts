import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExecutableRegistry } from './executable-registry.js';
import { registerLocalTools } from './local-adapters.js';
import { connectMcpServer } from './mcp-adapter.js';

const schema = z.object({
  permissions: z.array(z.string()).default([]),
  mcpServers: z.array(z.object({ id: z.string().regex(/^[\w-]+$/), command: z.string().min(1),
    args: z.array(z.string()).default([]), allowedTools: z.array(z.string()) }).strict()).default([]),
}).strict();

/** Only an explicitly selected, user-owned configuration can launch MCP processes. */
export async function loadRuntime(workspace: string, configPath?: string, writeJournal?: string) {
  const config = schema.parse(configPath ? JSON.parse(await readFile(configPath, 'utf8')) : {});
  const registry = registerLocalTools(new ExecutableRegistry(), workspace, writeJournal);
  const close: Array<() => Promise<void>> = [];
  try {
    for (const server of config.mcpServers) close.push(await connectMcpServer(registry, server));
    return { registry, permissions: new Set(config.permissions),
      close: async () => { await Promise.allSettled(close.map(dispose => dispose())); } };
  } catch (error) {
    await Promise.allSettled(close.map(dispose => dispose()));
    throw error;
  }
}
