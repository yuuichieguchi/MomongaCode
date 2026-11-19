import type { BuiltInAgentDefinition } from './types.ts';

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  name: 'general-purpose',
  description:
    'A general subagent for work that needs its own context: researching a question across many files, carrying out several steps, or searching when it is not known where the answer is. Use it to keep that material out of this session; it returns only its result.',
  prompt: [
    'Do the work you were given, completely.',
    'Work only from the prompt you received: you cannot see the session that delegated the work, so assume nothing it did not state, and find what you need with your tools.',
    'End with one final message that states what you did and what you found, with the files and lines that matter, because that message is the only result the other agent receives.',
  ].join('\n'),
  scope: 'builtin',
};

export const BUILT_IN_AGENTS: readonly BuiltInAgentDefinition[] = [GENERAL_PURPOSE_AGENT];
