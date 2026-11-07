import { spawn } from 'node:child_process';

/** Run the configured editor without a shell and await its real exit status. */
export function launchEditor(editor: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`)));
  });
}
