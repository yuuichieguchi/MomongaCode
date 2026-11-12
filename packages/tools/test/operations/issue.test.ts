import { describe, expect, it } from 'vitest';
import { OPERATION_SPECS, createForgeAccess, loadForgeDescriptors, parseForgeDescriptor } from '@momonga/tools';
import type { ForgeDescriptor } from '@momonga/tools';
import { LAB_DESCRIPTOR, startFakeForge } from '@momonga/testkit';
import type { FakeForge, FakeIssue, ForgeShape } from '@momonga/testkit';
import { contextFor, countingRunner, TEST_FETCH, makeGitWorld, onCleanup, operationTool, partsOf, settle, subjectFor } from './support.ts';

const CREDENTIAL = 'fake-forge-credential-for-tests';
const HEAD_SHA = 'a'.repeat(40);

const descriptorFor = (shape: ForgeShape): ForgeDescriptor => {
  if (shape === 'lab') return parseForgeDescriptor(LAB_DESCRIPTOR);
  const shipped = loadForgeDescriptors().find((descriptor) => descriptor.id === 'github');
  if (shipped === undefined) throw new Error('no shipped descriptor with id github');
  return shipped;
};

const setup = async (shape: ForgeShape) => {
  const forge = await startFakeForge(shape, CREDENTIAL);
  onCleanup(() => forge.close());
  forge.branchSha.set('feature/x', HEAD_SHA);
  const world = makeGitWorld();
  world.git(world.work, 'remote', 'set-url', 'origin', `${forge.origin}/acme/widgets.git`);
  const descriptor = descriptorFor(shape);
  const access = createForgeAccess({
    descriptors: [descriptor],
    instances: [{ id: 'local', descriptor: descriptor.id, hosts: [forge.host], apiBaseUrl: forge.origin, credential: { env: 'FAKE_FORGE_TOKEN' } }],
    fetch: TEST_FETCH,
    readCredential: async () => CREDENTIAL,
  });
  const runner = countingRunner();
  return { forge, world, tool: (name: string) => operationTool(name, { runArgv: runner.run, forge: access }) };
};

const issueSeven = (overrides: Partial<FakeIssue> = {}): FakeIssue => ({
  number: 7,
  title: 'The widget list is empty',
  body: 'Opening the list shows nothing.',
  state: 'open',
  labels: ['momonga'],
  author: 'reporter',
  authorAssociation: 'MEMBER',
  ...overrides,
});

const outputOf = (result: unknown): string => (result as { output: string }).output;

const runOn = async (forge: FakeForge, world: ReturnType<typeof makeGitWorld>, tool: ReturnType<typeof operationTool>, input: Record<string, unknown>) => {
  const parts = partsOf(tool, input, contextFor(world.work, world.env));
  return parts.execute(await parts.prepare());
};

describe('the operation catalogue', () => {
  it('lists IssueRead and IssueComment', () => {
    const names = OPERATION_SPECS.map((spec) => spec.name);
    expect(names).toContain('IssueRead');
    expect(names).toContain('IssueComment');
  });
});

describe.each(['hub', 'lab'] as const)('issue operations against the %s forge shape', (shape) => {
  describe('IssueRead', () => {
    it('reads the title, state, author and text of the issue and every comment, and changes nothing', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.issues.push(issueSeven());
      forge.issueComments.set(7, ['It started after the update', 'Same here']);
      const read = await runOn(forge, world, tool('IssueRead'), { number: 7 });
      expect(read).toMatchObject({ status: 'completed' });
      const output = outputOf(read);
      expect(output).toContain('Issue #7: The widget list is empty');
      expect(output).toContain('opened by reporter');
      expect(output).toContain('Opening the list shows nothing.');
      expect(output).toContain('2 comments');
      expect(output).toContain('comment 1 by commenter:\nIt started after the update');
      expect(output).toContain('comment 2 by commenter:\nSame here');
      expect(forge.requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('says the issue has no description when its text is empty', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.issues.push(issueSeven({ body: null }));
      const output = outputOf(await runOn(forge, world, tool('IssueRead'), { number: 7 }));
      expect(output).toContain('Issue #7: The widget list is empty');
      expect(output).toContain('no description');
      expect(output).toContain('0 comments');
    });

    it('needs no approval of a person: its subject is the tool alone', async () => {
      const { world, tool } = await setup(shape);
      expect(await subjectFor(tool('IssueRead'), { number: 7 }, world)).toEqual({ kind: 'none', tool: 'IssueRead' });
    });
  });

  describe('IssueComment, whose guard is none', () => {
    it('posts one comment on the issue with the hidden marker of the call', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.issues.push(issueSeven());
      const read = await runOn(forge, world, tool('IssueComment'), { number: 7, body: 'Opened a pull request for this' });
      expect(read).toMatchObject({ status: 'completed' });
      expect(outputOf(read)).toContain('Comment posted on issue #7');
      expect(forge.issueComments.get(7)).toHaveLength(1);
      expect(forge.issueComments.get(7)?.[0]).toContain('Opened a pull request for this');
      expect(forge.issueComments.get(7)?.[0]).toContain('momonga-operation:');
    });

    it('finds the comment applied by its marker after the response was lost, and posts once', async () => {
      const { forge, world, tool } = await setup(shape);
      forge.issues.push(issueSeven());
      const parts = partsOf(tool('IssueComment'), { number: 7, body: 'Done' }, contextFor(world.work, world.env));
      const prepared = await parts.prepare();
      forge.faultNext('comment', 'apply_then_drop');
      await settle(() => parts.execute(prepared));
      const reconciled = await parts.reconcile(prepared, Date.now());
      expect(reconciled.outcome).toBe('already_applied');
      expect(forge.issueCommentPosts()).toBe(1);
    });

    it('asks by rule and names the issue in its title', async () => {
      const { world, tool } = await setup(shape);
      const subject = await subjectFor(tool('IssueComment'), { number: 7, body: 'x' }, world);
      expect(subject).toMatchObject({ kind: 'forge', tool: 'IssueComment', approval: 'rule' });
    });
  });

  describe('PullRequestCreate for an issue', () => {
    const CREATE = { head: 'feature/x', base: 'main', title: 'Fix the list', body: 'Shows the widgets again', headSha: HEAD_SHA };

    const sentBody = (forge: FakeForge): unknown => {
      const create = forge.requests.find((request) => request.method === 'POST');
      const fields = create?.body as Record<string, unknown> | undefined;
      return fields?.[shape === 'hub' ? 'body' : 'description'];
    };

    it('ends the body with Closes #<issue> when the call names the issue', async () => {
      const { forge, world, tool } = await setup(shape);
      const result = await runOn(forge, world, tool('PullRequestCreate'), { ...CREATE, issue: 7 });
      expect(result).toMatchObject({ status: 'completed' });
      expect(sentBody(forge)).toBe('Shows the widgets again\n\nCloses #7');
    });

    it('sends the body as given when the call names no issue', async () => {
      const { forge, world, tool } = await setup(shape);
      await runOn(forge, world, tool('PullRequestCreate'), CREATE);
      expect(sentBody(forge)).toBe('Shows the widgets again');
    });
  });
});
