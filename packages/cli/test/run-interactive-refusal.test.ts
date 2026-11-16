import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import type { HandoverStart } from '../src/handover/start.ts';
import { restoreRefusedText } from '../src/handover/texts.ts';
import type { CliPorts, Terminal } from '../src/ports.ts';
import { LEAVE_EVERY_MODE } from '../src/tui/terminal/modes.ts';
import { runInteractive } from '../src/tui/run-interactive.tsx';

const REFUSAL_REASON = 'the record was written by another build';

describe('runInteractive started by a move whose record is refused', () => {
  it('leaves every terminal mode, turns raw input off, prints the refusal with its reason and exits with the failure code, opening no screen', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const screenFile = path.join(home, 'screen');
    const descriptor = fs.openSync(screenFile, 'w');
    context.onTestFinished(() => fs.closeSync(descriptor));
    const rawModes: boolean[] = [];
    const stderr: string[] = [];
    const started: HandoverStart = { file: path.join(home, 'record.json'), parsed: { kind: 'refused', reason: REFUSAL_REASON }, terminal: undefined };
    const ports = { home, cwd: home, env: {}, platform: process.platform, stderr: { write: (text: string) => void stderr.push(text) }, handover: { started } } as unknown as CliPorts;
    const terminal = { stdin: { setRawMode: (on: boolean) => void rawModes.push(on) }, stdout: { fd: descriptor, columns: 80, rows: 24 }, colourOff: () => undefined } as unknown as Terminal;

    const exit = await runInteractive(ports, paths, terminal, {}, undefined as never, undefined as never);

    expect(exit).toBe(EXIT_FAILURE);
    expect(rawModes).toEqual([false]);
    expect(fs.readFileSync(screenFile, 'utf8')).toBe(LEAVE_EVERY_MODE);
    expect(stderr.join('')).toBe(`momonga: ${restoreRefusedText({ reason: REFUSAL_REASON, kept: { kind: 'unnamed' } })}\n`);
  });
});
