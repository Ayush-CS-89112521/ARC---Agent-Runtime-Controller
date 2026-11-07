import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { setTimeout } from 'node:timers/promises';

const server = new McpServer({ name: 'arc-isolated-fixture', version: '1.0.0' });
let cancellationObserved = false;
server.registerTool('echo', { inputSchema: { text: z.string() }, outputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: { text } }));
server.registerTool('slow', { inputSchema: { text: z.string() } }, async ({ text }, extra) => {
  try { await setTimeout(5000, undefined, { signal: extra.signal }); }
  catch (error) { cancellationObserved = extra.signal.aborted; throw error; }
  return { content: [{ type: 'text', text }] };
});
server.registerTool('stats', { inputSchema: {}, outputSchema: { cancelled: z.boolean() } }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ cancelled: cancellationObserved }) }],
  structuredContent: { cancelled: cancellationObserved },
}));
await server.connect(new StdioServerTransport());
