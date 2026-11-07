import { z } from "zod";
import type { DevTool } from "../types.js";
import { run } from "../exec.js";

const schema = z.object({
  port: z.coerce.number().int().min(1).max(65535),
});
type Input = z.infer<typeof schema>;

export interface PortOutput {
  port: number;
  occupied: boolean;
  pid?: number;
  processName?: string;
  hint?: string;
}

async function lookupUnix(port: number): Promise<{ pid: number; name: string } | null> {
  // lsof: -F gives machine-readable fields: p<pid>, c<command>
  const l = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (l.code === 0 && l.stdout) {
    let pid: number | undefined;
    let name: string | undefined;
    for (const line of l.stdout.split("\n")) {
      if (line.startsWith("p") && pid === undefined) pid = Number(line.slice(1));
      else if (line.startsWith("c") && name === undefined) name = line.slice(1);
    }
    if (pid && name) return { pid, name };
  }

  // Fallback for minimal Linux images without lsof.
  const s = await run("ss", ["-ltnpH", `sport = :${port}`]);
  if (s.code === 0 && s.stdout.trim()) {
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(s.stdout);
    if (m) return { name: m[1] as string, pid: Number(m[2]) };
    return { name: "unknown (need elevated permissions)", pid: 0 };
  }
  return null;
}

async function lookupWindows(port: number): Promise<{ pid: number; name: string } | null> {
  const n = await run("netstat", ["-ano", "-p", "TCP"]);
  if (n.code !== 0) return null;
  const row = n.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((c) => c[3] === "LISTENING" && c[1]?.endsWith(`:${port}`));
  if (!row) return null;
  const pid = Number(row[4]);
  const t = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const name = /^"([^"]+)"/.exec(t.stdout.trim())?.[1] ?? "unknown";
  return { pid, name };
}

export const portFree: DevTool<Input, PortOutput> = {
  id: "port.free",
  description: "Check whether a TCP port is in use and report the owning PID and process name (read-only; never kills).",
  schema,
  risk: "low",
  commands({ port }) {
    const cmd = process.platform === "win32" ? "netstat -ano -p TCP" : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
    return [
      `inspect TCP port ${port} via ${cmd}`,
      "lookup owning PID and process name without stopping it",
    ];
  },

  async dryRun({ port }) {
    const tool = process.platform === "win32" ? "netstat/tasklist" : "lsof (or ss)";
    return `Would query ${tool} for listeners on TCP port ${port} and report PID + process name. Read-only; nothing is stopped.`;
  },

  async execute({ port }) {
    const hit =
      process.platform === "win32" ? await lookupWindows(port) : await lookupUnix(port);
    if (!hit) return { port, occupied: false };
    return {
      port,
      occupied: true,
      pid: hit.pid || undefined,
      processName: hit.name,
      hint:
        hit.pid > 0
          ? process.platform === "win32"
            ? `To free it: taskkill /PID ${hit.pid}`
            : `To free it: kill ${hit.pid}  (use kill -9 only if it ignores SIGTERM)`
          : "Re-run with elevated permissions to see the owning process.",
    };
  },

  formatResult(output) {
    return {
      warning: output.occupied ? `Port ${output.port} is occupied` : undefined,
      details: [
        output.occupied
          ? `In use by process "${output.processName}" (PID: ${output.pid}).${output.hint ? ` ${output.hint}` : ""}`
          : `Port ${output.port} is free and ready for use.`,
      ],
    };
  },
};
