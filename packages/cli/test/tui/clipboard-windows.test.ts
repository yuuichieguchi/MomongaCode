import { execFileSync } from '@momonga/testkit/child-process';
import { describe, expect, it } from 'vitest';
import { findProgramOnPath, nodeFileSystem, systemTiming } from '@momonga/foundation';
import { createClipboardPrograms } from '../../src/tui/screen/clipboard-host.ts';
import { cachedProgramSearch, readClipboardThroughRoutes } from '../../src/tui/screen/clipboard.ts';

const SAMPLE = 'MomongaCode clipboard read ✓';

describe.skipIf(process.platform !== 'win32')('the Windows read route of the clipboard, on a real Windows host (R13; skipped on every other platform)', () => {
  it('reads the text the host clipboard holds through PowerShell', async () => {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Set-Clipboard -Value '${SAMPLE}'`]);
    const programs = createClipboardPrograms();
    try {
      const content = await readClipboardThroughRoutes(
        { env: process.env, findProgram: cachedProgramSearch((name) => findProgramOnPath(name, process.env, nodeFileSystem)), capture: programs.capture },
        systemTiming,
        new AbortController().signal,
      );
      expect(content).toEqual({ kind: 'text', text: SAMPLE });
    } finally {
      programs.stop();
    }
  });
});
