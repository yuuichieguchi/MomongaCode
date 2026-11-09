import { watchLifeline } from '../../src/lifeline.ts';

const lines: string[] = [];
let overlong = 0;
const keepAlive = setInterval(() => undefined, 60_000);

const report = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const blockFor = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const watch = watchLifeline(3, {
  onLine: (line) => {
    if (line === 'block') {
      report('blocking');
      blockFor(Number(process.env['LIFELINE_BLOCK_MS'] ?? '300'));
      return;
    }
    lines.push(line);
  },
  onOverlongLine: () => {
    overlong += 1;
  },
  onEnd: () => undefined,
});

process.on('SIGTERM', () => {
  const seenAtSignal = lines.length;
  void watch.drain().then(() => {
    report(JSON.stringify({ seenAtSignal, lines, overlong }));
    watch.dispose();
    clearInterval(keepAlive);
  });
});

report('watching');
