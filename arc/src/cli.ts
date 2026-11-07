#!/usr/bin/env node
import pc from "picocolors";
import { ToolRegistry } from "./registry.js";
import { installSanitizedStreams } from "./sanitizer.js";
import { envAudit } from "./tools/env-audit.js";
import { gitSafeBranch } from "./tools/git-safe-branch.js";
import { portFree } from "./tools/port-free.js";
import { Reporter } from "./ui/reporter.js";

// Everything printed from here on is masked, no exceptions.
installSanitizedStreams();

const VERSION = "0.1.0";
const registry = new ToolRegistry().register(envAudit).register(gitSafeBranch).register(portFree);

const USAGE = `ARC - Agent Runtime Controller

Usage:
  arc list
  arc run <tool.id> [--dry-run] [--yes] [--json] [--<field> <value> ...] [--input '<json>']

Flags:
  --dry-run   Preview what would change; touches nothing.
  --yes       Confirm execution of medium/high-risk tools.
  --json      Machine-readable output.
  --input     Full tool input as JSON (merged under any --<field> flags).

Examples:
  arc run env.audit
  arc run port.free --port 3000
  arc run git.safe_branch --name feat/login --dry-run
  arc run git.safe_branch --name feat/login --yes
`;

const CONTROL = new Set(["dry-run", "yes", "json", "input", "help"]);

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["dry-run", "yes", "json"].includes(key)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { positionals, flags };
}

async function main(): Promise<number> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [command, toolId] = positionals;
  for (const key of ['yes', 'dry-run', 'json']) {
    if (flags[key] !== undefined && flags[key] !== true) {
      console.error(`Invalid flag --${key}: use the flag without a value.`);
      return 1;
    }
  }

  if (!command || flags["help"] || command === "help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "list") {
    const badge = pc.bgCyan(pc.black(pc.bold(" ARC ")));
    console.log(`\n${badge}  ${pc.bold("Agent Runtime Controller")} ${pc.dim(`v${VERSION} · tools`)}\n`);
    for (const t of registry.list()) {
      const riskColor = t.risk === "high" ? pc.red : t.risk === "medium" ? pc.yellow : pc.dim;
      console.log(`  ${pc.bold(t.id.padEnd(20))} ${riskColor(`[${t.risk.padEnd(6)}]`)} ${pc.dim(t.description)}`);
    }
    console.log();
    return 0;
  }

  if (command !== "run" || !toolId) {
    console.error(USAGE);
    return 1;
  }

  const tool = registry.get(toolId);
  if (!tool) {
    console.error(pc.red(`✖ Unknown tool '${toolId}'. Run 'arc list' to see available tools.`));
    return 1;
  }

  let input: Record<string, unknown> = {};
  if (typeof flags["input"] === "string") {
    try {
      input = JSON.parse(flags["input"]) as Record<string, unknown>;
      if (input === null || Array.isArray(input) || typeof input !== 'object') {
        throw new Error('Expected an object');
      }
    } catch {
      console.error(pc.red("✖ --input is not valid JSON"));
      return 1;
    }
  }
  for (const [k, v] of Object.entries(flags)) {
    if (CONTROL.has(k)) continue;
    input[k] = typeof v === "string" ? coerce(v) : true;
  }

  // Pure JSON mode for pipelines and scripting
  if (flags["json"]) {
    const outcome = await registry.run(toolId, input, {
      mode: flags["dry-run"] ? "dry-run" : "execute",
      confirmed: Boolean(flags["yes"]),
    });
    console.log(JSON.stringify(outcome, null, 2));
    return outcome.ok ? 0 : 1;
  }

  // Parse input against tool schema
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    console.error(pc.red(`✖ Invalid input for '${toolId}': ${issues}`));
    return 1;
  }

  const toolInput = parsed.data;
  const isDryRun = Boolean(flags["dry-run"]);
  const autoApprove = Boolean(flags["yes"]);

  let commands: string[];
  if (typeof tool.commands === "function") {
    commands = tool.commands(toolInput);
  } else if (Array.isArray(tool.commands)) {
    commands = tool.commands;
  } else {
    commands = [`${tool.id} ${JSON.stringify(toolInput)}`];
  }

  let preview: string | undefined;
  if (isDryRun) {
    preview = await tool.dryRun(toolInput);
  }

  const reporter = new Reporter({
    version: VERSION,
    dryRun: isDryRun,
    yes: autoApprove,
  });

  reporter.banner();

  const summary = await reporter.run([
    {
      title: tool.id,
      commands,
      risk: tool.risk,
      preview,
      run: async () => {
        const res = await tool.execute(toolInput);
        if (tool.formatResult) {
          return tool.formatResult(res);
        }
        return {
          details: [JSON.stringify(res, null, 2)],
        };
      },
      suggest: (err) => `Fix the issue: ${err.message}`,
    },
  ]);

  return summary.failed > 0 || summary.aborted ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
