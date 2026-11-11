import { describe, expect, it } from 'vitest';
import type { CommanderError } from 'commander';
import { encodeOutcomeFile, formatImproveOutcome, outcomeFileOf, parseGuidelineCandidate } from '@momonga/eval';
import type { ImproveOutcome } from '@momonga/eval';
import type { EntryIo } from '@momonga/foundation';
import { adoptOutcome, formatGuidelines } from '../src/commands/context.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { terminalPorts } from '../src/terminal-writer.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';

const program = () => {
  const reads: string[] = [];
  const ports = {
    version: '9.9.9',
    home: '/h',
    cwd: '/w',
    terminal: undefined,
    stdout: { write: () => undefined },
    files: {
      readText: async (file: string) => {
        reads.push(file);
        throw new Error('the dataset must not be read');
      },
    },
  } as unknown as CliPorts;
  const built = buildProgram({
    ports,
    entries: {} as DaemonEntries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  const quiet = (command: typeof built): void => {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
    command.commands.forEach((nested) => quiet(nested as typeof built));
  };
  quiet(built);
  return { built, reads };
};

const parse = (args: string[]) => {
  const { built, reads } = program();
  return { reads, parsed: built.parseAsync(args, { from: 'user' }) };
};

const assertRejected = async (args: string[], pattern: RegExp) => {
  const { parsed, reads } = parse(args);
  const error = (await parsed.then(() => undefined, (reason: unknown) => reason)) as CommanderError | Error | undefined;
  expect(error?.message).toMatch(pattern);
  expect(error?.message).not.toMatch(/unknown command/);
  expect(reads).toEqual([]);
};

describe('momonga context improve', () => {
  it('guards a command with no input: --dataset is required', async () => {
    await assertRejected(['context', 'improve', '--model', 'opus', '--token-cap', '700', '--outcome', 'o.json'], /--dataset/);
  });

  it('guards a name that is not a model: --alias is no longer an option', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--alias', 'opus', '--token-cap', '700', '--outcome', 'o.json'], /unknown option '--alias'/);
  });

  it('guards an unchosen analysis model: --model is required', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--token-cap', '700', '--outcome', 'o.json'], /--model/);
  });

  it('guards a cost nobody accepted: --token-cap is required and checked before the dataset is read', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--outcome', 'o.json'], /--token-cap/);
  });

  it.each(['0', '-5', '1.5', 'many'])('guards an invented cap: --token-cap %s is refused before the dataset is read', async (value) => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--outcome', 'o.json', '--token-cap', value], /--token-cap/);
  });
});

describe('momonga context improve and adopt', () => {
  it('guards an outcome that is never written: --outcome is required, before the dataset is read', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--token-cap', '700'], /--outcome/);
  });

  it('guards a text stored unseen: improve has no --adopt', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--token-cap', '700', '--outcome', 'o.json', '--adopt'], /--adopt/);
  });

  it('guards an adoption of nothing: adopt takes an outcome file', async () => {
    await assertRejected(['context', 'guideline', 'adopt'], /outcome-file/);
  });
});

describe('what a model reply puts in the text of context improve', () => {
  const REPLY = '\u001b[2K\u001b]0;pwn\u0007‮ not json';

  it('reaches stdout escaped when the parse error of a candidate reply carries the reply', () => {
    const parsed = parseGuidelineCandidate({ text: REPLY });
    if (!('error' in parsed)) throw new Error('the reply must not parse');
    expect(parsed.error).toMatch(/\u001b|‮/u);
    const outcome: ImproveOutcome = {
      status: 'no_winner',
      model: 'real',
      analysisModel: 'opus',
      seed: 1,
      candidateCount: 1,
      tokenCap: 700,
      current: undefined,
      baseline: { contrastiveFailures: 1, compactedScenarios: 1, tokens: 1 },
      contrastive: ['a'],
      skipped: [{ scenario: 's', reason: parsed.error }],
      analyses: 1,
      candidates: [{ index: 0, skipped: parsed.error }],
      tokens: { benchmark: 1, charged: 1 },
    };
    const written: string[] = [];
    const ports = terminalPorts({ stdout: { write: (text: string) => void written.push(text) }, stderr: { write: () => undefined } } as unknown as CliPorts);

    ports.stdout.write(`${formatImproveOutcome(outcome)}\n`);

    expect(written.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u);
    expect(written.join('')).toContain('\\u001b[2K');
  });
});

describe('adopting from an outcome file', () => {
  const WINNER_TEXT = 'Always keep the word keepsake in STATE.';

  const outcome = (parent: { version: number; text: string } | undefined): ImproveOutcome => ({
    status: 'winner',
    model: 'real',
    analysisModel: 'opus',
    seed: 7,
    candidateCount: 5,
    tokenCap: 700,
    current: parent,
    baseline: { contrastiveFailures: 1, compactedScenarios: 4, tokens: 10 },
    contrastive: ['a'],
    skipped: [],
    analyses: 1,
    candidates: [{ index: 1, text: WINNER_TEXT, contrastiveFailures: 0 }],
    winner: { index: 1, text: WINNER_TEXT, parent: parent?.version ?? null, contrastiveFailures: 0, comparison: { gate: { passed: true, checks: [] } } as never },
    tokens: { benchmark: 10, charged: 5 },
  });

  const fileText = (parent: { version: number; text: string } | undefined = undefined): string => encodeOutcomeFile(outcomeFileOf(outcome(parent), { name: 'd', digest: 'b'.repeat(64) }));

  const clientAt = (current: { version: number; text: string } | null) => {
    const calls: string[] = [];
    const adopted: unknown[] = [];
    const client = {
      guidelines: async () => {
        calls.push('guidelines');
        return { current: current === null ? null : { ...current, parent: null, createdAt: 1, adoptedAt: 1, report: {} }, guidelines: [] };
      },
      adoptGuideline: async (request: { text: string }) => {
        calls.push('adopt');
        adopted.push(request);
        return { version: (current?.version ?? 0) + 1, text: request.text, parent: current?.version ?? null, createdAt: 1, adoptedAt: 1, report: {} };
      },
    };
    return { client, calls, adopted };
  };

  const sink = () => {
    const written: string[] = [];
    return { stdout: { write: (text: string) => void written.push(text) }, written };
  };

  it('shows the whole text first, then stores exactly that text with the report of the file', async () => {
    const { client, calls, adopted } = clientAt(null);
    const { stdout, written } = sink();
    expect(await adoptOutcome(stdout, client, fileText())).toBe(0);
    expect(calls).toEqual(['guidelines', 'adopt']);
    expect(adopted).toEqual([{ text: WINNER_TEXT, parent: null, report: expect.objectContaining({ source: 'context improve', candidateIndex: 1 }) }]);
    const printed = written.join('');
    expect(printed).toContain(`  ${WINNER_TEXT}`);
    expect(printed).toContain(`+ ${WINNER_TEXT}`);
    expect(printed).toContain('adopted version 1');
    expect(printed.indexOf(WINNER_TEXT)).toBeLessThan(printed.indexOf('adopted version 1'));
  });

  it('guards a changed parent: another version is current, so nothing is stored', async () => {
    const { client, adopted } = clientAt({ version: 2, text: 'newer' });
    await expect(adoptOutcome(sink().stdout, client, fileText({ version: 1, text: 'older' }))).rejects.toThrow(/made against version 1.*version 2 is current/);
    expect(adopted).toEqual([]);
  });

  it('guards a changed parent that kept its number: the text in force differs, so nothing is stored', async () => {
    const { client, adopted } = clientAt({ version: 1, text: 'rewritten' });
    await expect(adoptOutcome(sink().stdout, client, fileText({ version: 1, text: 'older' }))).rejects.toThrow(/text of version 1/);
    expect(adopted).toEqual([]);
  });

  it('guards a first adoption on a guideline that appeared meanwhile', async () => {
    const { client, adopted } = clientAt({ version: 1, text: 'older' });
    await expect(adoptOutcome(sink().stdout, client, fileText())).rejects.toThrow(/made against no guideline.*version 1 is current/);
    expect(adopted).toEqual([]);
  });

  it('guards a file changed after improve wrote it: nothing is asked of the daemon', async () => {
    const { client, calls } = clientAt(null);
    const raw = JSON.parse(fileText()) as { winner: { text: string } };
    raw.winner.text = 'Another text.';
    const changed = JSON.stringify(raw);
    await expect(adoptOutcome(sink().stdout, client, changed)).rejects.toThrow(/digest/);
    expect(calls).toEqual([]);
  });
});

describe('listing guidelines', () => {
  it('prints the text with control characters escaped, so a stored text cannot rewrite the screen', () => {
    const view = { version: 1, text: 'keep names\u001b[2K\rhidden\nsecond', parent: null, createdAt: 1, adoptedAt: 1, report: {} };
    const printed = formatGuidelines({ current: view, guidelines: [view] });
    expect(printed).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(printed).toContain('keep names\\u001b[2K\\u000dhidden');
    expect(printed).toContain('  second');
  });

  it.each(['061C', '200E', '200F', '202A', '202B', '202C', '202D', '202E', '2066', '2067', '2068', '2069'])('prints the bidirectional control U+%s as an escape', (hex) => {
    const character = String.fromCodePoint(Number.parseInt(hex, 16));
    const view = { version: 1, text: `keep${character}names`, parent: null, createdAt: 1, adoptedAt: 1, report: {} };
    const printed = formatGuidelines({ current: view, guidelines: [view] });
    expect(printed).not.toContain(character);
    expect(printed).toContain(`keep\\u${hex.toLowerCase()}names`);
  });
});

describe('momonga context guideline rollback', () => {
  it('guards a typo: the version must be an integer of at least 1', async () => {
    await assertRejected(['context', 'guideline', 'rollback', 'latest'], /integer/);
  });
});
