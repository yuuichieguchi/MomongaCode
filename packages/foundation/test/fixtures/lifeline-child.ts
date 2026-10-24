import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { watchLifeline } from '../../src/lifeline.ts';

const resultFile = process.env['LIFELINE_RESULT_FILE'];
let calls = 0;

const report = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

if (process.env['LIFELINE_GRANDCHILD'] === '1') {
  const grandchild = spawn('/bin/sleep', ['30'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
  grandchild.unref();
  report(`grandchild ${grandchild.pid}`);
}

const keepAlive = setInterval(() => undefined, 60_000);

const dispose = watchLifeline(3, () => {
  calls += 1;
  if (resultFile !== undefined) fs.writeFileSync(resultFile, 'eof');
  report('eof');
  if (process.env['LIFELINE_COUNT'] === '1') {
    setTimeout(() => {
      report(`calls ${calls}`);
      clearInterval(keepAlive);
      process.exitCode = 0;
    }, 500);
    return;
  }
  clearInterval(keepAlive);
  process.exitCode = 0;
});

if (resultFile !== undefined) fs.writeFileSync(`${resultFile}.watching`, '');

if (process.env['LIFELINE_DISPOSE'] === '1') {
  dispose();
  report('disposed');
  setTimeout(() => {
    report(`calls ${calls}`);
    clearInterval(keepAlive);
  }, 1000);
} else {
  report('watching');
}
