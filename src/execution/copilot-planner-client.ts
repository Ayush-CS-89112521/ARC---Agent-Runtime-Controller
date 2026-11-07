export function copilotPromptArgs(prompt: string): string[] {
  return ['copilot', '--', '-s', '-p', prompt, '--available-tools=', '--disable-builtin-mcps',
    '--deny-tool=shell', '--deny-tool=write', '--deny-tool=read', '--deny-tool=memory', '--deny-tool=url',
    '--no-custom-instructions', '--no-ask-user', '--no-auto-update', '--sync-session=off', '--log-level=error'];
}

/** Invoke the installed Copilot CLI as a planner, with direct tool execution disabled. */
export async function runCopilotPlanner(prompt: string, signal?: AbortSignal,
  options: { cwd?: string; usageFile?: string } = {}): Promise<string> {
  const { execFile } = await import('child_process');
  const env = { ...process.env };
  for (const key of ['DATABASE_URL', 'ARC_POSTGRES_ADMIN_PASSWORD', 'ARC_POSTGRES_APP_PASSWORD']) delete env[key];
  const args = copilotPromptArgs(prompt);
  if (options.usageFile) args.push('--usage-output-file', options.usageFile);
  return new Promise<string>((resolve, reject) => {
    execFile('gh', args, {
      ...(signal ? { signal } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), env,
      timeout: 60000, maxBuffer: 5 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
