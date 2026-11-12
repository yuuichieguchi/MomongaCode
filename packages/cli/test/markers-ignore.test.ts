import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markerRemedyText } from '@momonga/foundation';
import { survivorNoticeText } from '../../foundation/src/process-markers.ts';
import { refusalText } from '../../tools/src/marker-guard.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const NAME = 'a'.repeat(64);
const GROUP = 4242;
const SPENT = { spent: { guard: true, sweep: true, startup: true, shutdown: true }, ignored: false };
const SLASH_AS_RUNNABLE = new RegExp(`run /markers ignore ${NAME}\\.`);

describe('C48 the remedy for a call blocked by a marker exists on every surface that shows it', () => {
  it('the headless form names stopping the process with its group and the interactive session for /markers ignore', () => {
    const text = markerRemedyText({ name: NAME, group: GROUP, addressed: 'person' });
    expect(text).toContain(`Stop the process group ${GROUP}`);
    expect(text).toContain(`/markers ignore ${NAME} in an interactive session`);
    expect(text).not.toMatch(SLASH_AS_RUNNABLE);
  });

  it('the headless form without a recorded group names the process', () => {
    expect(markerRemedyText({ name: NAME, group: undefined, addressed: 'person' })).toContain('Stop the process that holds it');
  });

  it('a blocked call refused by the guard tells the model the remedy that exists on every surface', () => {
    const text = refusalText('settled', NAME, GROUP, SPENT);
    expect(text).toContain(`Ask the person to stop the process group ${GROUP}`);
    expect(text).toContain(`/markers ignore ${NAME} in an interactive session`);
    expect(text).not.toMatch(SLASH_AS_RUNNABLE);
  });

  it('the notice of a process that may still run names the stop form and its group', () => {
    const text = survivorNoticeText('tool', NAME, GROUP);
    expect(text).toContain(`Stop the process group ${GROUP}`);
    expect(text).not.toMatch(SLASH_AS_RUNNABLE);
  });

  it('momonga markers remains no command (decision 51 A)', () => {
    const sources = ['packages/cli/src/program.ts', 'packages/cli/src/commands/register.ts'].map((relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
    expect(sources).not.toMatch(/\.command\(['"]markers/);
  });
});
