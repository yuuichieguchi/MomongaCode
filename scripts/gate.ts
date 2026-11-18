import fs from 'node:fs';
import { GATE_FORMAT, gateRecordPathOf, gitCommonDirOf, headOf, parseGateRecord, readGateRecordText, writeGateRecord } from '../test/support/gate-once.ts';

const USAGE = 'usage: node scripts/gate.ts <open|status|close>';
const USAGE_EXIT = 64;
const REFUSED_EXIT = 1;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const complain = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const runGate = (argv: readonly string[], cwd: string, now: Date): number => {
  const [command, ...rest] = argv;
  if (rest.length > 0 || (command !== 'open' && command !== 'status' && command !== 'close')) {
    complain(USAGE);
    return USAGE_EXIT;
  }
  const recordPath = gateRecordPathOf(gitCommonDirOf(cwd));
  const text = readGateRecordText(recordPath);
  if (command === 'open') {
    if (text !== undefined) {
      const existing = parseGateRecord(text);
      complain(existing === undefined ? `gate: ${recordPath} already exists and is not a ${GATE_FORMAT} record; nothing was changed` : `gate: a gate is already open on ${existing.head} (opened ${existing.openedAt}); nothing was changed`);
      return REFUSED_EXIT;
    }
    const head = headOf(cwd);
    writeGateRecord(recordPath, { format: GATE_FORMAT, head, openedAt: now.toISOString(), wholeRuns: {} });
    say(`gate: opened on ${head}`);
    return 0;
  }
  if (text === undefined) {
    if (command === 'status') {
      say('gate: no gate is open');
      return 0;
    }
    complain('gate: no gate is open; nothing to close');
    return REFUSED_EXIT;
  }
  if (command === 'close') {
    fs.rmSync(recordPath);
    say(`gate: closed (${recordPath} removed)`);
    return 0;
  }
  const record = parseGateRecord(text);
  if (record === undefined) {
    complain(`gate: ${recordPath} is not a ${GATE_FORMAT} record`);
    return REFUSED_EXIT;
  }
  say(`gate: open on ${record.head} since ${record.openedAt}`);
  const runs = Object.entries(record.wholeRuns);
  if (runs.length === 0) say('no whole run yet');
  for (const [project, run] of runs) say(`${project}: whole run on ${run.head} at ${run.startedAt}`);
  return 0;
};

if (import.meta.main) process.exitCode = runGate(process.argv.slice(2), process.cwd(), new Date());
