import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONCEPTS, MESSAGE_KEYS, NOT_RUN_REASONS, SURFACES, STOP_REASONS, VOCABULARY, WORDS, attachRunCommand, bannedVariantsIn, budgetSentence, messageOf, notRunWord, reopenSessionCommand, shellQuote, stopWord, withBillingRemedy, withSignInRemedy } from '../src/index.ts';
import type { BudgetExhausted, VocabularyRow } from '../src/index.ts';

const rowOf = (concept: (typeof CONCEPTS)[number]): VocabularyRow => VOCABULARY[concept];

describe('the one vocabulary table (ruling 2026-11-11, cli-commands DECISION-10)', () => {
  it('names for every word the design or the ruling that fixes it', () => {
    expect(CONCEPTS.filter((concept) => rowOf(concept).fixedBy.trim() === '')).toEqual([]);
  });

  it('keeps the words the model names design fixes, and a server is a model server', () => {
    expect([WORDS.connection, WORDS.provider, WORDS.ownName, WORDS.server]).toEqual(['connection', 'provider', 'own name', 'server']);
    expect(['connection', 'provider', 'ownName'].map((concept) => VOCABULARY[concept as 'connection' | 'provider' | 'ownName'].fixedBy.startsWith('design/models.md section '))).toEqual([true, true, true]);
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

const DESIGN_DOCUMENTS_VARIABLE = 'MOMONGA_DESIGN_DOCUMENTS';
const RULING = 'ruling-2026-11-11.md cli-commands DECISION-10';
const RULING_ONLY = ['product', 'command', 'session', 'run', 'folder'];
const DESIGN_CITATION = /^design\/([a-z-]+\.md) sections? (\d+(?:\.\d+)*)(?: to (\d+(?:\.\d+)*))?$/;

const citationsOf = (concept: (typeof CONCEPTS)[number]): string[] => rowOf(concept).fixedBy.split('; ');

const designCitations = CONCEPTS.flatMap((concept) => citationsOf(concept).filter((citation) => citation !== RULING).map((citation) => ({ concept, citation })));

describe('every fixedBy names a section of a permanent design document (design/protocol-schema.md B7)', () => {
  it('cites each design as design/<area>.md section <n>, and the ruling only beside the concepts it alone fixes', () => {
    expect(designCitations.filter(({ citation }) => !DESIGN_CITATION.test(citation))).toEqual([]);
    expect(CONCEPTS.filter((concept) => citationsOf(concept).every((citation) => citation === RULING))).toEqual(RULING_ONLY);
    expect(CONCEPTS.flatMap((concept) => rowOf(concept).banned.flatMap((banned) => ('keptFor' in banned ? [banned.keptFor] : []))).filter((note) => /design-[a-z-]+(?:-\d{4}-\d{2}-\d{2})?\.md/.test(note))).toEqual([]);
  });

  const folder = process.env[DESIGN_DOCUMENTS_VARIABLE];
  const title = `finds the file and the section of every design citation in the design folder named by ${DESIGN_DOCUMENTS_VARIABLE}`;
  if (folder === undefined) {
    it(title, (context) => context.skip(`${DESIGN_DOCUMENTS_VARIABLE} names no folder in this run; the release gate sets it`));
  } else {
    it(title, () => {
      const missing = designCitations.flatMap(({ concept, citation }) => {
        const [, file, ...sections] = DESIGN_CITATION.exec(citation) ?? [];
        const target = path.join(folder, file as string);
        if (!fs.existsSync(target)) return [`${concept}: ${citation}: no file ${target}`];
        const text = fs.readFileSync(target, 'utf8');
        return sections
          .filter((section): section is string => section !== undefined)
          .filter((section) => !new RegExp(`^(?:#+ )?${section.replaceAll('.', '\\.')}[. ]`, 'm').test(text))
          .map((section) => `${concept}: ${citation}: no section ${section} in ${file}`);
      });
      expect(missing).toEqual([]);
    });
  }
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
    expect(messageOf('sessionInOtherFolder', 'cli', { id: 's1', folder: '/work/other', platform: 'darwin' })).toBe('That session belongs to the folder /work/other. Run: cd /work/other && momonga --resume s1');
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
      billingChangeRefused: (surface) => messageOf('billingChangeRefused', surface, { model: 'm', from: 'plan', to: 'metered' }),
      modelAmbiguous: (surface) => messageOf('modelAmbiguous', surface, { text: 'x', choices: ['a/x', 'b/x'] }),
      modelNotConfigured: (surface) => messageOf('modelNotConfigured', surface, { text: 'x', choices: [] }),
      sessionNotFound: (surface) => messageOf('sessionNotFound', surface, { id: 'i' }),
      sessionIdTooShort: (surface) => messageOf('sessionIdTooShort', surface, { id: 'i', minimum: 8 }),
      sessionAmbiguous: (surface) => messageOf('sessionAmbiguous', surface, { id: 'i', matches: ['i1', 'i2'] }),
      sessionInOtherFolder: (surface) => messageOf('sessionInOtherFolder', surface, { id: 'i', folder: '/f', platform: 'darwin' }),
      noSessionToContinue: (surface) => messageOf('noSessionToContinue', surface, { folder: '/f' }),
      notAnId: (surface) => messageOf('notAnId', surface, { value: '..' }),
      optionNeedsPrint: (surface) => messageOf('optionNeedsPrint', surface, { option: '--verbose' }),
      optionNeedsInteractive: (surface) => messageOf('optionNeedsInteractive', surface, { option: '--screen-reader' }),
      promptGivenTwice: (surface) => messageOf('promptGivenTwice', surface, { prompt: 'two' }),
      resumeNeedsIdToPrint: (surface) => messageOf('resumeNeedsIdToPrint', surface),
      issueNeedsMandate: (surface) => messageOf('issueNeedsMandate', surface),
      issueBesidePrompt: (surface) => messageOf('issueBesidePrompt', surface),
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

describe('the words of a stop, a not-run reason, the budget, the shell quoting and the billing notice', () => {
  it('gives a word, not the identifier, for each stop reason and each not-run reason', () => {
    for (const reason of STOP_REASONS) expect(stopWord(reason)).not.toBe(reason);
    for (const reason of NOT_RUN_REASONS) expect(notRunWord(reason)).not.toBe(reason);
    expect(new Set(STOP_REASONS.map(stopWord)).size).toBe(STOP_REASONS.length);
    expect(new Set(NOT_RUN_REASONS.map(notRunWord)).size).toBe(NOT_RUN_REASONS.length);
  });

  it('writes the one budget sentence for each cause, with the figures the caller formats', () => {
    const format = (_dimension: BudgetExhausted['dimension'], value: number): string => String(value);
    expect(budgetSentence({ dimension: 'steps', cause: 'limit', spent: 5, limit: 5 }, format)).toBe('The run stopped at its step limit (5 of 5 used or reserved).');
    expect(budgetSentence({ dimension: 'retries', cause: 'cap_too_small', spent: 2, limit: 3, admitsAt: 4 }, format)).toBe(
      'The run stopped at its retry limit: what is left does not pay for another model request (2 of 3 used or reserved). A budget of 4 admits the next model request.',
    );
    expect(budgetSentence({ dimension: 'cost', cause: 'unpriced', spent: 1, limit: 2 }, format)).toBe(
      'The run stopped at its money limit: a model call has no price, so its cost cannot be counted (1 of 2 used or reserved).',
    );
  });

  it('quotes an argument in the form of the host shell: the Windows form for win32, the POSIX form elsewhere', () => {
    expect(shellQuote('a b', 'win32')).toBe('"a b"');
    expect(shellQuote('a b', 'darwin')).toBe("'a b'");
    expect(shellQuote('plain', 'win32')).toBe('plain');
  });

  it('stores the billing refusal with no surface remedy, and the remedy of the surface is added where the notice is shown', () => {
    const notice = messageOf('billingChangeRefused', 'tui', { model: 'm', from: 'a', to: 'b' });
    expect(notice).not.toContain('/models billing');
    expect(notice).not.toContain('models billing allow');
    expect(withBillingRemedy(notice, 'tui', 'a', 'b')).toBe(`${notice} Run /models billing.`);
    expect(withBillingRemedy(notice, 'cli', 'a', 'b')).toBe(`${notice} Run ${WORDS.command} models billing allow a b.`);
  });

  it('stores the expired sign-in with no command, and the surface names its own sign-in command where the notice is shown', () => {
    const notice = 'The sign-in of this account has expired';
    expect(withSignInRemedy(notice, 'tui')).toBe(`${notice} Run /login to sign in again.`);
    expect(withSignInRemedy(notice, 'cli')).toBe(`${notice} Run ${WORDS.command} auth login to sign in again.`);
  });
});
