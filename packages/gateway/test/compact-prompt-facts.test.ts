import { describe, expect, it } from 'vitest';
import { COMPACTION_INSTRUCTIONS_VERSION, WORKING_FACT_KINDS } from '@momonga/protocol';
import type { AdapterCompactRequest } from '@momonga/protocol';
import { factKindsSentence, summaryRequestOf } from '../src/adapters/shared/compact.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { userText } from './cc-support.ts';

const request: AdapterCompactRequest = { model: 'system', input: [userText('Fix the parser')], momonga: {} };
const instructions = (): string => summaryRequestOf(request, 512, EVERY_REASONING_IS_OWN).instructions ?? '';

describe('the summary instructions ask for no fact the working state records', () => {
  it('no longer asks for files or command results', () => {
    const text = instructions();
    expect(text).not.toContain('files read or changed');
    expect(text).not.toContain('commands run and their results');
  });

  it('carries one sentence naming every kind the working state renders', () => {
    expect(WORKING_FACT_KINDS.length).toBeGreaterThan(0);
    const sentence = factKindsSentence(WORKING_FACT_KINDS);
    expect(instructions().split(sentence)).toHaveLength(2);
    for (const kind of WORKING_FACT_KINDS) expect(sentence).toContain(kind);
    expect(sentence).toMatch(/^Code records .+ and gives them to the next agent separately; do not list them\.$/);
  });

  it('changes the sentence when a kind is added to the list', () => {
    const extended = [...WORKING_FACT_KINDS, 'an added kind'];
    expect(factKindsSentence(extended)).not.toBe(factKindsSentence(WORKING_FACT_KINDS));
    expect(factKindsSentence(extended)).toContain('an added kind');
  });

  it('raises the instructions version to 4', () => {
    expect(COMPACTION_INSTRUCTIONS_VERSION).toBe(4);
  });
});
