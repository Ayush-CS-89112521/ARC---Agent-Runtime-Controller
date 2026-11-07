import { chmod, readFile, writeFile, access, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DevTool } from "../types.js";
import { run } from "../exec.js";

const PROTECTED = ["main", "master"];
const GUARD_MARKER = "# arc:protected-branch-guard";

const schema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    // Conservative whitelist; git check-ref-format is still run for the final word.
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use letters, digits, '.', '_', '-', '/' only")
    .refine((n) => !PROTECTED.includes(n), "Cannot create a branch named main/master"),
  base: z.string().optional(), // branch/ref to start from; defaults to current HEAD
  installGuard: z.boolean().default(true), // pre-commit hook blocking commits on main/master
  cwd: z.string().default("."),
});
type Input = z.infer<typeof schema>;

export interface SafeBranchOutput {
  branch: string;
  from: string;
  guard: "installed" | "already-present" | "skipped-existing-hook" | "disabled";
}

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

async function preflight(i: Input): Promise<{ current: string; problems: string[] }> {
  const problems: string[] = [];
  const cwd = path.resolve(i.cwd);

  const inside = await git(cwd, "rev-parse", "--is-inside-work-tree");
  if (inside.code !== 0) return { current: "", problems: [`${cwd} is not a git repository.`] };

  const cur = await git(cwd, "symbolic-ref", "--short", "-q", "HEAD");
  const current = cur.code === 0 ? cur.stdout.trim() : "";
  if (!current) problems.push("HEAD is detached; check out a branch first.");

  const status = await git(cwd, "status", "--porcelain");
  if (status.stdout.trim()) {
    const n = status.stdout.trim().split("\n").length;
    problems.push(`Working directory is not clean (${n} changed path(s)). Commit or stash first.`);
  }

  const fmt = await git(cwd, "check-ref-format", "--branch", i.name);
  if (fmt.code !== 0) problems.push(`'${i.name}' is not a valid git branch name.`);

  const exists = await git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${i.name}`);
  if (exists.code === 0) problems.push(`Branch '${i.name}' already exists.`);

  if (i.base) {
    const b = await git(cwd, "rev-parse", "--verify", "--quiet", `${i.base}^{commit}`);
    if (b.code !== 0) problems.push(`Base ref '${i.base}' does not exist.`);
  }
  return { current, problems };
}

async function installGuard(cwd: string): Promise<SafeBranchOutput["guard"]> {
  const hookPathOut = await git(cwd, "rev-parse", "--git-path", "hooks/pre-commit");
  const hookPath = path.resolve(cwd, hookPathOut.stdout.trim());

  let existing: string | null = null;
  try {
    existing = await readFile(hookPath, "utf8");
  } catch {
    /* no hook yet */
  }
  if (existing !== null) {
    // Never clobber a user's own hook.
    return existing.includes(GUARD_MARKER) ? "already-present" : "skipped-existing-hook";
  }

  await mkdir(path.dirname(hookPath), { recursive: true });
  const script = `#!/bin/sh
${GUARD_MARKER}
branch=$(git symbolic-ref --short -q HEAD)
case "$branch" in
  ${PROTECTED.join("|")})
    echo "arc: direct commits to '$branch' are blocked. Create a branch (arc run git.safe_branch) or use --no-verify to override." >&2
    exit 1
    ;;
esac
exit 0
`;
  await writeFile(hookPath, script, "utf8");
  await access(hookPath);
  await chmod(hookPath, 0o755);
  return "installed";
}

export const gitSafeBranch: DevTool<Input, SafeBranchOutput> = {
  id: "git.safe_branch",
  description:
    "Verify a clean working tree, create a feature branch, and block direct commits to main/master via a pre-commit hook.",
  schema,
  risk: "medium",
  commands(input) {
    return [
      "git status --porcelain (verify clean tree)",
      `git check-ref-format --branch ${input.name}`,
      `git switch -c ${input.name}${input.base ? ` ${input.base}` : ""}`,
      input.installGuard ? "install .git/hooks/pre-commit (block commits on main/master)" : "# skip guard",
    ];
  },

  async dryRun(input) {
    const { current, problems } = await preflight(input);
    const from = input.base ?? (current || "HEAD");
    if (problems.length) {
      return `Would REFUSE to proceed:\n${problems.map((p) => `  - ${p}`).join("\n")}`;
    }
    const lines = [
      `Working tree is clean on '${current}'.`,
      `Would create and switch to new branch '${input.name}' from '${from}'.`,
    ];
    lines.push(
      input.installGuard
        ? `Would install .git/hooks/pre-commit that blocks commits on ${PROTECTED.join("/")} (skipped if you already have a pre-commit hook).`
        : "Would not install the protected-branch hook.",
    );
    lines.push("No remote operations. No existing files are modified.");
    return lines.join("\n");
  },

  async execute(input) {
    const cwd = path.resolve(input.cwd);
    const { current, problems } = await preflight(input);
    if (problems.length) throw new Error(problems.join(" "));

    const from = input.base ?? current;
    const args = ["switch", "-c", input.name];
    if (input.base) args.push(input.base);
    const sw = await git(cwd, ...args);
    if (sw.code !== 0) throw new Error(`git switch failed: ${sw.stderr.trim() || sw.stdout.trim()}`);

    const guard = input.installGuard ? await installGuard(cwd) : "disabled";
    return { branch: input.name, from, guard };
  },

  formatResult(output) {
    return {
      details: [
        `Switched to new branch '${output.branch}' (from '${output.from}').`,
        `Commit guard hook: ${output.guard} (blocks commits on ${PROTECTED.join("/")}).`,
      ],
    };
  },
};
