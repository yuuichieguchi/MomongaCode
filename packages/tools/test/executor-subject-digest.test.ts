import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { subjectDigestOf } from '@momonga/tools';

import { approvalOf, makeBuiltins } from './builtins/fixtures.ts';

import { expectedDigestOf } from './harness.ts';
import { syncPaths } from '@momonga/foundation';
import { testPaths } from '@momonga/testkit';

const SHOWN = { shown: { title: 'shown', input: {} } };

const subjectContext = (tools: Awaited<ReturnType<typeof makeBuiltins>>) => ({
  cwd: tools.session.cwd,
  workingDirectory: tools.session.workingDirectory,
  home: tools.layout.home,
  paths: testPaths(),
  roots: [tools.layout.project],
});

const toolOf = (tools: Awaited<ReturnType<typeof makeBuiltins>>, name: string) => {
  const tool = tools.toolSet.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
};

const subjectOf = (tools: Awaited<ReturnType<typeof makeBuiltins>>, name: string, args: unknown) => toolOf(tools, name).subject(args, subjectContext(tools));

describe('subjectDigestOf', () => {
  it('equals the digest of a needs_approval outcome for a path subject', async () => {
    const tools = await makeBuiltins();
    const args = { file_path: path.join(tools.layout.project, 'new.txt'), content: 'x' };
    const asked = approvalOf(await tools.run('Write', args));
    expect(await expectedDigestOf(toolOf(tools, 'Write'), args, tools)).toBe(asked.subjectDigest);
  });

  it('equals the digest of a needs_approval outcome for a command subject', async () => {
    const tools = await makeBuiltins();
    const args = { command: 'rm -r build' };
    const asked = approvalOf(await tools.run('Bash', args));
    expect(await expectedDigestOf(toolOf(tools, 'Bash'), args, tools)).toBe(asked.subjectDigest);
  });

  it('differs for the same command run from a different cwd', async () => {
    const tools = await makeBuiltins();
    const subject = subjectOf(tools, 'Bash', { command: 'rm -r build' });
    expect(await subjectDigestOf(subject, SHOWN, tools.layout.project, syncPaths.resolveCanonicalPath)).not.toBe(await subjectDigestOf(subject, SHOWN, tools.layout.outside, syncPaths.resolveCanonicalPath));
  });

  it('differs when only what is shown differs', async () => {
    const tools = await makeBuiltins();
    const subject = subjectOf(tools, 'Bash', { command: 'rm -r build' });
    const other = { shown: { title: 'shown', input: {}, claim: 'Clean the build' } };
    expect(await subjectDigestOf(subject, SHOWN, tools.layout.project, syncPaths.resolveCanonicalPath)).not.toBe(await subjectDigestOf(subject, other, tools.layout.project, syncPaths.resolveCanonicalPath));
  });

  it('rethrows EMFILE from the canonicalise it is given', async () => {
    const tools = await makeBuiltins();
    const emfile = Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
    const subject = subjectOf(tools, 'Write', { file_path: path.join(tools.layout.project, 'new.txt'), content: 'x' });
    let caught: unknown;
    try {
      await subjectDigestOf(subject, SHOWN, tools.session.cwd, () => {
        throw emfile;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(emfile);
  });
});
