import { testSecretLocations } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { DecideInput, Decision } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { BASH } from './decision-rows.ts';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from './helpers.ts';

const READ = { name: 'Read', kind: 'read', sideEffect: 'read_only' } as const;
const EDIT = { name: 'Edit', kind: 'edit', sideEffect: 'write', subjectKind: 'path' } as const;

const setup = async () => {
  const layout = makeLayout();
  const skill = path.join(layout.outside, 'skills', 'pdf');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'scripts', 'run.py'), 'print(1)\n');
  fs.writeFileSync(path.join(layout.outside, 'other.txt'), 'x\n');
  const fileRules = await fileRulesFor([], [layout.project]);
  const base = (mode: PermissionMode): Omit<DecideInput, 'tool' | 'subject'> => ({ secretLocations: testSecretLocations(layout.home),
    mode,
    rules: [],
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fileRules,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: isWritableFor([layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
  });
  return { layout, skill, base };
};

const readOf = (target: string) => ({ kind: 'path', tool: 'Read', paths: [target], access: 'read' }) as const;

describe('readRoots', () => {
  it('allows a read under a read root without asking', async () => {
    const { skill, base } = await setup();
    const decision: Decision = await decide({ ...base('manual'), readRoots: [skill], tool: READ, subject: readOf(path.join(skill, 'scripts', 'run.py')) });
    expect(decision).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('still asks for a read outside every root', async () => {
    const { layout, skill, base } = await setup();
    const decision = await decide({ ...base('manual'), readRoots: [skill], tool: READ, subject: readOf(path.join(layout.outside, 'other.txt')) });
    expect(decision.kind).toBe('ask');
  });

  it('asks without read roots', async () => {
    const { skill, base } = await setup();
    expect((await decide({ ...base('manual'), tool: READ, subject: readOf(path.join(skill, 'scripts', 'run.py')) })).kind).toBe('ask');
  });

  it('does not make the read root writable', async () => {
    const { skill, base } = await setup();
    const decision = await decide({
      ...base('acceptEdits'),
      readRoots: [skill],
      tool: EDIT,
      subject: { kind: 'path', tool: 'Edit', paths: [path.join(skill, 'scripts', 'run.py')], access: 'write' },
    });
    expect(decision.kind).toBe('ask');
  });

  it('applies to the read targets of a read-only command', async () => {
    const { skill, base } = await setup();
    const target = path.join(skill, 'scripts', 'run.py');
    const withRoot = await decide({ ...base('manual'), readRoots: [skill], tool: BASH, subject: { kind: 'command', tool: 'Bash', command: `cat ${target}` } });
    const without = await decide({ ...base('manual'), tool: BASH, subject: { kind: 'command', tool: 'Bash', command: `cat ${target}` } });
    expect(withRoot.kind).toBe('allow');
    expect(without.kind).toBe('ask');
  });

  it('keeps a deny rule stronger than a read root', async () => {
    const { layout, skill, base } = await setup();
    const rule = ruleIn(layout)('deny', `Read(/${skill}/**)`);
    const decision = await decide({
      ...base('manual'),
      rules: [rule],
      fileRules: await fileRulesFor([rule], [layout.project]),
      readRoots: [skill],
      tool: READ,
      subject: readOf(path.join(skill, 'scripts', 'run.py')),
    });
    expect(decision.kind).toBe('deny');
  });
});
