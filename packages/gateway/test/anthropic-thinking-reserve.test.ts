import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summaryInputLimitFor, summaryTokenCapFor } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { anthropicCountTokensReply, anthropicTextReply } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway } from './upstream-gateway-support.ts';

const BUDGET_TARGET: Capabilities = {
  ...REMOTE_CAPABILITIES,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  reasoning: { control: 'thinking', form: 'budget', budgets: { low: 60_000 } },
};

describe('compaction on a budget-form target', () => {
  it('never sends an input at the summary limit with a max_tokens that overflows the context window', async () => {
    const todayLimit = summaryInputLimitFor(BUDGET_TARGET, summaryTokenCapFor(BUDGET_TARGET), 0);
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(todayLimit), anthropicTextReply(['summary'])], capabilities: BUDGET_TARGET });

    await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: 'fast', input: userInput('do X') }));

    const sent: any[] = gateway.fake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body);
    for (const body of sent) expect(todayLimit + body.max_tokens).toBeLessThanOrEqual(BUDGET_TARGET.contextWindow);
  });
});

const packagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('one function decides the output tokens a request may spend', () => {
  it.for([
    path.join('gateway', 'src', 'adapters', 'anthropic', 'request.ts'),
    path.join('gateway', 'src', 'core', 'unary.ts'),
    path.join('context', 'src', 'budget.ts'),
  ])('%s reads outputTokensFor', (relative) => {
    expect(fs.readFileSync(path.join(packagesDir, relative), 'utf8')).toMatch(/\boutputTokensFor\(/);
  });
});
