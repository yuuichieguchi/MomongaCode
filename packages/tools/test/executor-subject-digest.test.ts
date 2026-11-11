import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { subjectDigestOf } from '@momonga/tools';

import type { NeedsApprovalOutcome } from '@momonga/tools';
import { approvalOf, makeBuiltins } from './builtins/fixtures.ts';

import { expectedSubjectDigest } from './harness.ts';
import { syncPaths } from '@momonga/foundation';
import { testPaths } from '@momonga/testkit';


const subjectContext = (tools: Awaited<ReturnType<typeof makeBuiltins>>) => ({
  cwd: tools.session.cwd,
  workingDirectory: tools.session.workingDirectory,
  home: tools.layout.home,
  paths: testPaths(),
  roots: [tools.layout.project],
});

const subjectOf = (tools: Awaited<ReturnType<typeof makeBuiltins>>, name: string, args: unknown) => {
  const tool = tools.toolSet.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.subject(args, subjectContext(tools));
};

describe('subjectDigestOf', () => {
  it('equals the digest of a needs_approval outcome for a path subject', async () => {
    const tools = await makeBuiltins();
    const args = { file_path: path.join(tools.layout.project, 'new.txt'), content: 'x' };
    const asked: NeedsApprovalOutcome = approvalOf(await tools.run('Write', args));
    expect(await subjectDigestOf(subjectOf(tools, 'Write', args), tools.session.cwd, syncPaths.resolveCanonicalPath)).toBe(asked.subjectDigest);
  });

  it('equals the digest of a needs_approval outcome for a command subject', async () => {
    const tools = await makeBuiltins();
    const args = { command: 'rm -r build' };
    const asked = approvalOf(await tools.run('Bash', args));
    const digest = await subjectDigestOf(subjectOf(tools, 'Bash', args), tools.session.cwd, syncPaths.resolveCanonicalPath);
    expect(digest).toBe(asked.subjectDigest);
    expect(digest).toBe(expectedSubjectDigest(subjectOf(tools, 'Bash', args), tools.session.cwd));
  });

  it('differs for the same command run from a different cwd', async () => {
    const tools = await makeBuiltins();
    const subject = subjectOf(tools, 'Bash', { command: 'rm -r build' });
    expect(await subjectDigestOf(subject, tools.layout.project, syncPaths.resolveCanonicalPath)).not.toBe(await subjectDigestOf(subject, tools.layout.outside, syncPaths.resolveCanonicalPath));
  });

  it('rethrows EMFILE from the canonicalise it is given', async () => {
    const tools = await makeBuiltins();
    const emfile = Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
    const subject = subjectOf(tools, 'Write', { file_path: path.join(tools.layout.project, 'new.txt'), content: 'x' });
    let caught: unknown;
    try {
      await subjectDigestOf(subject, tools.session.cwd, () => {
        throw emfile;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(emfile);
  });
});
