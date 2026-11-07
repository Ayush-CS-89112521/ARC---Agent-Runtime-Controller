import { createInterface } from 'node:readline';

/**
 * [y/N] prompt. Only "y" or "yes" approves. Enter, anything else, Ctrl+C,
 * Ctrl+D or a closed stdin all resolve to false: the safe abort.
 */
export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;

    const finish = (answer: boolean, viaEnter: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      if (!viaEnter) process.stdout.write('\n'); // keep the cursor on a fresh line
      resolve(answer);
    };

    rl.on('close', () => finish(false, false));
    rl.on('SIGINT', () => finish(false, false));
    rl.question(question + '\n', (a) => finish(/^y(es)?$/i.test(a.trim()), true));
  });
}
