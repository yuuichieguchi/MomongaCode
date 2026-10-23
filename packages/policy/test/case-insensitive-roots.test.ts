import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, volumeIsCaseInsensitive } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';
import { makeLayout } from './helpers.ts';

const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write' };

describe.runIf(volumeIsCaseInsensitive(os.tmpdir()))('roots compare case-insensitively on a case-insensitive volume', () => {
  it('allows a differently cased target under a root that does not exist yet in acceptEdits', () => {
    const layout = makeLayout();
    const root = path.join(layout.project, 'newdir');
    const target = path.join(layout.project, 'NEWDIR', 'f');
    const decision = decide({
      tool: WRITE,
      subject: { kind: 'path', tool: 'Write', paths: [target], access: 'write' },
      mode: 'acceptEdits',
      rules: [],
      roots: [root],
      home: layout.home,
      cwd: layout.project,
      protectedPaths: [],
    });
    expect(decision.kind).toBe('allow');
  });

  it('still asks for a target outside a missing root whatever its case', () => {
    const layout = makeLayout();
    const root = path.join(layout.project, 'newdir');
    const target = path.join(layout.project, 'OTHER', 'f');
    const decision = decide({
      tool: WRITE,
      subject: { kind: 'path', tool: 'Write', paths: [target], access: 'write' },
      mode: 'acceptEdits',
      rules: [],
      roots: [root],
      home: layout.home,
      cwd: layout.project,
      protectedPaths: [],
    });
    expect(decision.kind).toBe('ask');
  });
});
