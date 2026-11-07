import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DevTool } from "../types.js";
import { run } from "../exec.js";
import { detectSecretTypes } from "../sanitizer.js";

const schema = z.object({
  dir: z.string().default("."),
});
type Input = z.infer<typeof schema>;

export interface EnvFinding {
  severity: "high" | "medium" | "low";
  file: string;
  line?: number;
  key?: string;
  issue: string;
}
export interface EnvAuditOutput {
  scanned: string[];
  findings: EnvFinding[];
  ok: boolean;
}

// Files like .env, .env.local, .env.production. Templates are scanned for
// secrets but not for "missing values" (empty is the point of a template).
const ENV_FILE = /^\.env(\..+)?$/;
const TEMPLATE = /\.(example|sample|template|dist)$/;

// Variable names that usually hold secrets (used for "missing value" severity).
const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL)/i;

async function findEnvFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && ENV_FILE.test(e.name))
    .map((e) => e.name)
    .sort();
}

function parseLine(raw: string): { key: string; value: string } | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!m) return null;
  let value = m[2] ?? "";
  // Strip surrounding quotes, and trailing inline comments on unquoted values.
  const q = /^(["'])(.*)\1/.exec(value);
  if (q) value = q[2] ?? "";
  else value = value.replace(/\s+#.*$/, "");
  return { key: m[1] as string, value: value.trim() };
}

async function inGitRepo(dir: string): Promise<boolean> {
  const r = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === "true";
}

export const envAudit: DevTool<Input, EnvAuditOutput> = {
  id: "env.audit",
  description:
    "Scan .env files in a folder for exposed secrets, empty values, and .env files staged or untracked-but-not-ignored in git.",
  schema,
  risk: "low",
  commands: [
    "scan .env* files for exposed secrets",
    "check for OpenAI, Anthropic, AWS, GitHub patterns",
    "git diff --cached --name-only (verify staging)",
    "git check-ignore (verify .gitignore coverage)",
  ],

  async dryRun({ dir }) {
    const abs = path.resolve(dir);
    const files = await findEnvFiles(abs).catch(() => []);
    if (files.length === 0) return `No .env files found in ${abs}. Nothing would be scanned.`;
    return (
      `Would read (read-only) ${files.length} file(s) in ${abs}: ${files.join(", ")}.\n` +
      `Would check each for known secret formats (OpenAI, Anthropic, AWS, GitHub), empty values, ` +
      `and run 'git diff --cached' / 'git check-ignore' to see if any are staged or unprotected. ` +
      `Secret values are never printed. No files are modified.`
    );
  },

  async execute({ dir }) {
    const abs = path.resolve(dir);
    const files = await findEnvFiles(abs);
    const findings: EnvFinding[] = [];

    for (const file of files) {
      const isTemplate = TEMPLATE.test(file);
      const content = await readFile(path.join(abs, file), "utf8");
      const lines = content.split(/\r?\n/);

      lines.forEach((raw, i) => {
        const kv = parseLine(raw);
        if (!kv) return;

        const types = detectSecretTypes(kv.value);
        if (types.length > 0) {
          findings.push({
            severity: isTemplate ? "high" : "medium",
            file,
            line: i + 1,
            key: kv.key,
            issue: isTemplate
              ? `Real-looking ${types.join("/")} secret committed in a template file.`
              : `Contains a ${types.join("/")} secret (value hidden).`,
          });
        }

        if (!isTemplate && kv.value === "") {
          findings.push({
            severity: SECRETISH.test(kv.key) ? "medium" : "low",
            file,
            line: i + 1,
            key: kv.key,
            issue: "Missing value.",
          });
        }
      });
    }

    // Git checks only make sense in a repo, and only for non-template files.
    if (await inGitRepo(abs)) {
      const staged = await run("git", ["diff", "--cached", "--name-only", "-z"], { cwd: abs });
      const stagedSet = new Set(staged.stdout.split("\0").filter(Boolean));
      const real = files.filter((f) => !TEMPLATE.test(f));

      // Staged paths are relative to the repo root; resolve to absolute to compare.
      const top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: abs })).stdout.trim();
      for (const f of real) {
        const rel = path.relative(top, path.join(abs, f)).split(path.sep).join("/");
        if (stagedSet.has(rel)) {
          findings.push({
            severity: "high",
            file: f,
            issue: `Staged for commit. Run: git restore --staged ${f}`,
          });
        }
        const tracked = await run("git", ["ls-files", "--error-unmatch", "--", f], { cwd: abs });
        if (tracked.code === 0) {
          findings.push({
            severity: "high",
            file: f,
            issue: `Already tracked by git. Run: git rm --cached ${f} (and rotate any secrets it held).`,
          });
        } else {
          const ignored = await run("git", ["check-ignore", "-q", "--", f], { cwd: abs });
          if (ignored.code !== 0) {
            findings.push({
              severity: "medium",
              file: f,
              issue: "Not covered by .gitignore; one 'git add .' away from leaking.",
            });
          }
        }
      }
    }

    const rank = { high: 0, medium: 1, low: 2 } as const;
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { scanned: files, findings, ok: !findings.some((f) => f.severity !== "low") };
  },

  formatResult(output) {
    if (output.findings.length === 0) {
      return {
        details: [
          `Scanned ${output.scanned.length} file(s): clean, no exposed secrets or issues found.`,
          "All environment files are safely configured.",
        ],
      };
    }
    const high = output.findings.filter((f) => f.severity === "high").length;
    const warning =
      high > 0
        ? `${output.findings.length} issue(s) detected (${high} high severity)`
        : `${output.findings.length} issue(s) detected`;
    return {
      warning,
      details: output.findings.map(
        (f) => `[${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ""} - ${f.issue}`,
      ),
    };
  },
};
