import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CommanderError } from 'commander';
import { encodeOutcomeFile, formatImproveOutcome, outcomeFileOf, parseGuidelineCandidate } from '@momonga/eval';
import type { ImproveOutcome } from '@momonga/eval';
import { EXIT_USAGE, momongaLayout } from '@momonga/foundation';
import type { EntryIo } from '@momonga/foundation';
import { CONTEXT_IMPROVE_TOKEN_NOTICE, adoptOutcome, contextImprove, defaultOutcomePathOf, exitOfImproveOutcome, formatGuidelines } from '../src/commands/context.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { terminalPorts } from '../src/terminal-writer.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { freshHome } from './fresh-home.ts';
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
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS }),
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
  it('guards a name that is not a model: --alias is no longer an option', async () => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--alias', 'opus', '--token-cap', '700', '--outcome', 'o.json'], /unknown option '--alias'/);
  });

  it.each(['0', '-5', '1.5', 'many'])('guards an invalid --token-cap %s before the dataset is read', async (value) => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--outcome', 'o.json', '--token-cap', value], /--token-cap/);
  });

  it.each(['0', '-2', '1.5', 'many'])('guards an invalid --candidates %s before the dataset is read', async (value) => {
    await assertRejected(['context', 'improve', '--dataset', 'd.json', '--model', 'opus', '--outcome', 'o.json', '--candidates', value], /--candidates/);
  });

  it('derives an automatic outcome file path under state/context-outcomes when --outcome is omitted', () => {
    const paths = momongaLayout('/tmp/home', process.platform, {});
    const target = defaultOutcomePathOf(paths, Date.UTC(2026, 10, 21, 6, 30, 0), '12345678-abcd-efgh');
    expect(target).toContain('context-outcomes');
    expect(target).toMatch(/2026-11-21T06-30-00-000Z-12345678\.json$/);
  });

  const homeWithStartModel = () => {
    const home = freshHome();
    const paths = momongaLayout(home, process.platform, {});
    fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      paths.settingsFile,
      JSON.stringify({
        models: {
          connections: [{ adapter: 'ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:18477', models: [{ id: 'qwen3.8:27b' }] }],
        },
      }),
      { mode: 0o600 },
    );
    return paths;
  };

  it('refuses non-interactive CLI runs without --yes, showing the plan and token-spending notice', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const paths = homeWithStartModel();
    const ports = {
      version: '9.9.9',
      home: paths.home,
      cwd: '/w',
      platform: process.platform,
      env: {},
      terminal: undefined,
      clock: { now: () => Date.UTC(2026, 10, 21, 6, 30, 0), sleep: async () => undefined },
      uuid: () => 'abcdef12-0000-0000-0000-000000000000',
      stdout: { write: (text: string) => void stdout.push(text) },
      stderr: { write: (text: string) => void stderr.push(text) },
      files: {},
    } as unknown as CliPorts;
    const code = await contextImprove(ports, paths, { seed: 0, interrupt: new AbortController().signal });
    expect(code).toBe(EXIT_USAGE);
    const errText = stderr.join('');
    expect(errText).toContain('Model: ollama/qwen3.8:27b');
    expect(errText).toContain('Dataset: bundled context-starter');
    expect(errText).toContain('Candidates: 1');
    expect(errText).toContain('Token budget: none');
    expect(errText).toContain(CONTEXT_IMPROVE_TOKEN_NOTICE);
    expect(errText).toContain('--yes');
  });

  it('asks for confirmation in an interactive terminal and cancels cleanly without starting a daemon', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdin = new PassThrough();
    const termOut = new PassThrough();
    const termWritten: string[] = [];
    termOut.on('data', (chunk) => termWritten.push(String(chunk)));
    const paths = homeWithStartModel();
    const ports = {
      version: '9.9.9',
      home: paths.home,
      cwd: '/w',
      platform: process.platform,
      env: {},
      terminal: { stdin, stdout: termOut, colourOff: () => undefined },
      clock: { now: () => Date.UTC(2026, 10, 21, 6, 30, 0), sleep: async () => undefined },
      uuid: () => 'abcdef12-0000-0000-0000-000000000000',
      stdout: { write: (text: string) => void stdout.push(text) },
      stderr: { write: (text: string) => void stderr.push(text) },
      files: {},
    } as unknown as CliPorts;
    stdin.end('2\n');
    const code = await contextImprove(ports, paths, { seed: 0, interrupt: new AbortController().signal });
    expect(code).toBe(EXIT_USAGE);
    expect(stdout.join('')).toContain('Dataset: bundled context-starter');
    expect(stdout.join('')).toContain(CONTEXT_IMPROVE_TOKEN_NOTICE);
    expect(stdout.join('')).toContain('cancelled; nothing was run');
    expect(termWritten.join('')).toContain('Start context improve?');
  });
});

describe('momonga context improve and adopt', () => {
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

describe('the exit of context improve', () => {
  it.for([
    ['winner', 0],
    ['empty', 1],
    ['no_analysis', 1],
    ['no_winner', 1],
    ['stopped', 1],
  ] as const)('exits %s with %i: only a winner is a measured improvement', ([status, exit]) => {
    expect(exitOfImproveOutcome({ status })).toBe(exit);
  });
});
