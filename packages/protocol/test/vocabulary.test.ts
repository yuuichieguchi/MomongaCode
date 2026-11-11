import { describe, expect, it } from 'vitest';
import { CONCEPTS, MESSAGE_KEYS, SURFACES, VOCABULARY, WORDS, attachRunCommand, bannedVariantsIn, messageOf, reopenSessionCommand } from '../src/index.ts';
import type { VocabularyRow } from '../src/index.ts';

const rowOf = (concept: (typeof CONCEPTS)[number]): VocabularyRow => VOCABULARY[concept];

describe('the one vocabulary table (ruling 2026-11-11, cli-commands DECISION-10)', () => {
  it('names for every word the design or the ruling that fixes it', () => {
    expect(CONCEPTS.filter((concept) => rowOf(concept).fixedBy.trim() === '')).toEqual([]);
  });

  it('keeps the words the model names design fixes, and a server is a model server', () => {
    expect([WORDS.connection, WORDS.provider, WORDS.ownName, WORDS.server]).toEqual(['connection', 'provider', 'own name', 'server']);
    expect(['connection', 'provider', 'ownName'].map((concept) => VOCABULARY[concept as 'connection' | 'provider' | 'ownName'].fixedBy.startsWith('design-model-names-2026-11-10.md'))).toEqual([true, true, true]);
    expect(VOCABULARY.server.concept).toBe('a model server the product starts or finds');
    expect([...VOCABULARY.connection.banned, ...VOCABULARY.provider.banned, ...VOCABULARY.ownName.banned]).toEqual([]);
  });

  it('gives one word per concept and bans no word that is the word of a concept', () => {
    const words = new Set<string>(CONCEPTS.map((concept) => WORDS[concept]));
    expect(words.size).toBe(CONCEPTS.length);
    expect(CONCEPTS.flatMap((concept) => rowOf(concept).banned.map((banned) => banned.variant)).filter((variant) => words.has(variant))).toEqual([]);
  });

  it('finds a banned variant as a whole word, with the word that replaces it', () => {
    expect(bannedVariantsIn('No conversation has the id 1.')).toEqual([{ concept: 'session', word: 'session', variant: 'conversation', keptFor: VOCABULARY.session.banned[0].keptFor }]);
    expect(bannedVariantsIn('the targets that answered').map((use) => [use.variant, use.word])).toEqual([['target', 'model']]);
    expect(bannedVariantsIn('the context was compacted by a compaction')).toEqual([]);
    expect(bannedVariantsIn('MomongaCode runs the momonga command')).toEqual([]);
    expect(bannedVariantsIn('Momonga Code').map((use) => use.word)).toEqual(['MomongaCode']);
  });
});

describe('messageOf: one builder per message, which names the command of the surface it is shown on', () => {
  it('says how to connect a model with a command of the surface', () => {
    expect(messageOf('noModelConnected', 'tui')).toBe('No model is connected. Use /login to connect one.');
    expect(messageOf('noModelConnected', 'cli')).toBe('No model is connected. Run momonga models add to add one, or momonga auth login to sign in.');
    for (const surface of SURFACES.filter((candidate) => candidate !== 'tui')) expect(messageOf('noModelConnected', surface)).not.toContain('/login');
  });

  it('builds the sentences of a model reference that names no one model', () => {
    expect(messageOf('modelAmbiguous', 'cli', { text: 'x', choices: ['a/x', 'b/x'] })).toBe('The model "x" is served by two servers: a/x, b/x. Write one of them.');
    expect(messageOf('modelNotConfigured', 'gateway', { text: 'x', choices: ['m'] })).toBe('The model "x" is not configured. Configured models: m.');
    expect(messageOf('modelNotConfigured', 'cli', { text: 'x', choices: [] })).toBe(`The model "x" is not configured. ${messageOf('noModelConnected', 'cli')}`);
  });

  it('calls the stored unit a session and its place a folder', () => {
    expect(messageOf('sessionNotFound', 'cli', { id: 'ffffffff' })).toBe('No session has the id ffffffff.');
    expect(messageOf('sessionIdTooShort', 'cli', { id: '0123456', minimum: 8 })).toBe('No session has the id 0123456. A shortened id needs at least 8 characters.');
    expect(messageOf('sessionAmbiguous', 'cli', { id: 'abcdefgh', matches: ['abcdefgh-1', 'abcdefgh-2'] })).toBe('abcdefgh matches more than one session: abcdefgh-1, abcdefgh-2');
    expect(messageOf('sessionInOtherFolder', 'cli', { id: 's1', folder: '/work/other' })).toBe('That session belongs to the folder /work/other. Run: cd /work/other && momonga --resume s1');
    expect(messageOf('noSessionToContinue', 'cli', { folder: '/work/project' })).toBe('No session to continue in the folder /work/project.');
  });

  it('names for kept work the command that takes the kind of id it holds', () => {
    const failure = { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'disk full' };
    expect(messageOf('handoverFailed', 'tui', { ...failure, kept: { kind: 'sessions', sessionIds: ['s1'] } })).toBe(
      `Could not restart into v1.2.4 (disk full). This session stays on v1.2.3 and keeps working until that version finishes its runs. Your runs keep going; open them with \`${reopenSessionCommand('s1')}\`. Your unsent input is still in the prompt.`,
    );
    expect(messageOf('handoverFailed', 'cli', { ...failure, kept: { kind: 'run', runId: 'r1' } })).toBe(
      `Could not restart into v1.2.4 (disk full). This session stays on v1.2.3 and keeps working until that version finishes its runs. Your runs keep going; open them with \`${attachRunCommand('r1')}\`.`,
    );
    expect(messageOf('handoverFailed', 'acp', { ...failure, kept: { kind: 'sessions', sessionIds: [] } })).toBe(
      'Could not restart into v1.2.4 (disk full). This session stays on v1.2.3 and keeps working until that version finishes its runs.',
    );
    expect(messageOf('restoreRefused', 'cli', { reason: 'the record is not JSON', kept: { kind: 'unnamed' } })).toBe('Could not restore the session (the record is not JSON). Your work is kept: run `momonga --resume`.');
    expect(messageOf('restoreRefused', 'cli', { reason: 'the record is of an ACP session', kept: { kind: 'sessions', sessionIds: ['s1', 's2'] } })).toBe(
      'Could not restore the session (the record is of an ACP session). Your work is kept: run `momonga --resume s1`, `momonga --resume s2`.',
    );
  });

  it('uses no banned variant in any message on any surface', () => {
    const samples: Record<(typeof MESSAGE_KEYS)[number], (surface: (typeof SURFACES)[number]) => string> = {
      noModelConnected: (surface) => messageOf('noModelConnected', surface),
      modelAmbiguous: (surface) => messageOf('modelAmbiguous', surface, { text: 'x', choices: ['a/x', 'b/x'] }),
      modelNotConfigured: (surface) => messageOf('modelNotConfigured', surface, { text: 'x', choices: [] }),
      sessionNotFound: (surface) => messageOf('sessionNotFound', surface, { id: 'i' }),
      sessionIdTooShort: (surface) => messageOf('sessionIdTooShort', surface, { id: 'i', minimum: 8 }),
      sessionAmbiguous: (surface) => messageOf('sessionAmbiguous', surface, { id: 'i', matches: ['i1', 'i2'] }),
      sessionInOtherFolder: (surface) => messageOf('sessionInOtherFolder', surface, { id: 'i', folder: '/f' }),
      noSessionToContinue: (surface) => messageOf('noSessionToContinue', surface, { folder: '/f' }),
      notAnId: (surface) => messageOf('notAnId', surface, { value: '..' }),
      optionNeedsPrint: (surface) => messageOf('optionNeedsPrint', surface, { option: '--verbose' }),
      optionNeedsInteractive: (surface) => messageOf('optionNeedsInteractive', surface, { option: '--screen-reader' }),
      promptGivenTwice: (surface) => messageOf('promptGivenTwice', surface, { prompt: 'two' }),
      resumeNeedsIdToPrint: (surface) => messageOf('resumeNeedsIdToPrint', surface),
      storedBypassNeedsOptIn: (surface) => messageOf('storedBypassNeedsOptIn', surface, { id: 'i' }),
      bypassNotStarted: (surface) => messageOf('bypassNotStarted', surface, { id: 'i' }),
      handoverFailed: (surface) => messageOf('handoverFailed', surface, { toVersion: '2', fromVersion: '1', reason: 'r', kept: { kind: 'run', runId: 'r1' } }),
      restoreRefused: (surface) => messageOf('restoreRefused', surface, { reason: 'r', kept: { kind: 'unnamed' } }),
      aboutModel: (surface) => messageOf('aboutModel', surface, { model: 'fm/system', text: 'the server was stopped' }),
      modelNotReady: (surface) => messageOf('modelNotReady', surface, { model: 'fm/system', reason: 'the executable is missing' }),
      modelIdChanged: (surface) => messageOf('modelIdChanged', surface, { server: 'fm', model: 'fm/system', listed: 'renamed', entry: 'system' }),
      serverSocketPathTooLong: (surface) => messageOf('serverSocketPathTooLong', surface, { model: 'fm/system', byteLength: 105, directory: '/run/g1', code: 'EINVAL' }),
      signInIdentityQuestion: (surface) => messageOf('signInIdentityQuestion', surface, { provider: 'ChatGPT', identity: 'ada@example.com', account: 'work' }),
      signInIdentityNotConfirmed: (surface) => messageOf('signInIdentityNotConfirmed', surface, { identity: 'ada@example.com', account: 'work', command: 'momonga auth login chatgpt --account work' }),
      accountWithoutModel: (surface) => messageOf('accountWithoutModel', surface, { provider: 'chatgpt', account: 'work' }),
      planRecordUnreadable: (surface) => messageOf('planRecordUnreadable', surface, { account: 'work', cause: 'bad tag', signInCommand: 'momonga auth login chatgpt --account work' }),
      serverFormNotOffered: (surface) => messageOf('serverFormNotOffered', surface, { server: 'loom', platform: 'win32', accepted: ['unix'], offered: ['pipe'] }),
      daemonStarting: (surface) => messageOf('daemonStarting', surface),
    };
    expect(MESSAGE_KEYS.flatMap((key) => SURFACES.flatMap((surface) => bannedVariantsIn(samples[key](surface)).map((use) => `${key} on ${surface}: ${use.variant}`)))).toEqual([]);
  });
});
