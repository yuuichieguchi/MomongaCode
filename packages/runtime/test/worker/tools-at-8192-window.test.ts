import { describe, expect, it } from 'vitest';
import type { FunctionTool } from '@momonga/protocol';
import { createBuiltinTools, createOperationTools } from '@momonga/tools';
import type { AnyTool, ArgvRunner, ForgeAccess } from '@momonga/tools';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const DECLARED_WINDOW = 8192;

const unused = (what: string) => (): never => {
  throw new Error(`the offer of the tools never calls ${what}`);
};

const productTools = (): AnyTool[] => [
  ...createBuiltinTools({ sandbox: 'seatbelt', sandboxNetwork: 'deny', bash: { kind: 'resolved', path: '/bin/bash' } }),
  ...createOperationTools({
    runArgv: unused('git') as ArgvRunner,
    forge: { request: unused('the forge'), gitCredential: unused('the forge'), gitDestination: unused('the forge') } as unknown as ForgeAccess,
    settings: {},
    platform: process.platform, shell: async () => '/bin/sh',
  }),
];

const namesOf = (body: unknown): string[] => ((body as { tools?: FunctionTool[] }).tools ?? []).map((tool) => tool.name);

describe('the tools a model declared with an 8192-token window is offered (tools-C32 establish)', () => {
  it('offers the essential tools with their companions and names the dropped ones in one notice', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(DECLARED_WINDOW) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Fix the bug', { history: 'fresh' });
    await env.runOnce(env.worker('worker-1', { toolList: productTools }));
    const offered = namesOf(env.ofType(run.id, 'model.requested')[0]?.body);
    const notices = env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tools_dropped').map((notice) => notice.message);
    expect(offered).toEqual(['Glob', 'Grep', 'Read', 'Edit', 'Write', 'ReadOutput', 'Bash', 'BashOutput', 'KillBash', 'UpdatePlan', 'GitBranch', 'GitCommit', 'GitFetch', 'GitPush', 'GitStage', 'GitUpdate', 'IssueComment', 'IssueRead', 'PullRequestComment']);
    expect(notices).toEqual([
      `The declared context window of fm (${DECLARED_WINDOW} tokens) leaves no room for these tools, so they were left out: PullRequestComments, PullRequestCreate, PullRequestMerge, PullRequestStatus (optional tools); raise the declared context window of that model, or shorten the instructions`,
    ]);
  });
});
