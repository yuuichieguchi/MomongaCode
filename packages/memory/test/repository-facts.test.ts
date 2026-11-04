import { describe, expect, it } from 'vitest';
import * as memory from '@momonga/memory';
import type { RunEvent, ToolFile } from '@momonga/protocol';

const PROJECT = '/work/a';
const COMMANDS = ['npm test', 'npm run lint', 'pytest'];
const MANIFESTS = ['package.json', 'Makefile'];

type Fact = { command: string; text: string; kind: string; check: { callId: string; seq: number }; manifestPaths: string[] };

type FactsInput = { status: string; events: readonly RunEvent[]; commands: readonly string[]; manifests: readonly string[] };

const exported = <T>(name: string): T => {
  const found = (memory as Record<string, unknown>)[name];
  if (typeof found !== 'function') throw new Error(`@momonga/memory does not export ${name}`);
  return found as T;
};

const repositoryFactText = (command: string): string => exported<(command: string) => string>('repositoryFactText')(command);

const repositoryFactsOf = (input: FactsInput): Fact[] => exported<(input: FactsInput) => Fact[]>('repositoryFactsOf')(input);

type Step = { name?: string; command?: string; exitCode?: number; files?: ToolFile[] };

const journal = (steps: readonly Step[]): RunEvent[] =>
  steps.flatMap((step, index) => {
    const callId = `c${index}`;
    return [
      { type: 'tool.call', seq: 3 * index + 1, callId, name: step.name ?? 'Bash', kind: step.files?.some((file) => file.access === 'write') === true ? 'edit' : 'other', rawInput: step.command === undefined ? {} : { command: step.command } },
      { type: 'tool.started', seq: 3 * index + 2, callId, idemKey: `k${index}`, basis: 'read_only' },
      {
        type: 'tool.completed',
        seq: 3 * index + 3,
        callId,
        status: 'completed',
        output: '',
        ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
        ...(step.files === undefined ? {} : { files: step.files }),
      },
    ] as unknown as RunEvent[];
  });

const facts = (steps: readonly Step[], status = 'COMPLETED'): Fact[] => repositoryFactsOf({ status, events: journal(steps), commands: COMMANDS, manifests: MANIFESTS });

const write = (file: string): Step => ({ name: 'Write', files: [{ path: `${PROJECT}/${file}`, sha256: 'aa', access: 'write' }] });
const read = (file: string, sha256 = 'bb'): Step => ({ name: 'Read', files: [{ path: `${PROJECT}/${file}`, sha256, access: 'read' }] });
const pass = (command = 'npm test'): Step => ({ command, exitCode: 0 });
const fail = (command = 'npm test'): Step => ({ command, exitCode: 1 });

describe('repositoryFactText', () => {
  it('states the command in one fixed sentence', () => {
    expect(repositoryFactText('npm test')).toBe('Run `npm test` to verify a change in this repository.');
  });

  it('is a pure function of the command: equal commands give equal text, distinct commands distinct text', () => {
    const commands = ['npm test', 'npm run lint', 'pytest', 'make check', 'cargo test'];
    for (const left of commands) {
      expect(repositoryFactText(left)).toBe(repositoryFactText(left));
      for (const right of commands) if (left !== right) expect(repositoryFactText(left)).not.toBe(repositoryFactText(right));
    }
  });
});

describe('repositoryFactsOf', () => {
  it('builds one procedure fact for a passing verification command, bound to the call that passed', () => {
    expect(facts([write('src/a.ts'), pass('npm test')])).toEqual([
      { command: 'npm test', text: 'Run `npm test` to verify a change in this repository.', kind: 'procedure', check: { callId: 'c1', seq: 6 }, manifestPaths: [] },
    ]);
  });

  it('builds one fact per distinct passing command, in the order of the passing calls, each with its own check', () => {
    const built = facts([write('src/a.ts'), pass('npm run lint'), pass('npm test'), pass('npm run lint')]);
    expect(built.map((fact) => [fact.command, fact.check])).toEqual([
      ['npm test', { callId: 'c2', seq: 9 }],
      ['npm run lint', { callId: 'c3', seq: 12 }],
    ]);
  });

  it('gives no fact for a command whose latest run failed, even if it passed before', () => {
    expect(facts([write('src/a.ts'), pass('npm run lint'), fail('npm run lint'), pass('npm test')]).map((fact) => fact.command)).toEqual(['npm test']);
  });

  it('gives no fact for a pass that a later write made out of date', () => {
    expect(facts([pass('npm run lint'), write('src/a.ts'), pass('npm test')]).map((fact) => fact.command)).toEqual(['npm test']);
  });

  it('gives no fact for a passing command that is not a verification command', () => {
    expect(facts([write('src/a.ts'), pass('make check'), pass('npm test')]).map((fact) => fact.command)).toEqual(['npm test']);
  });

  it('names the manifests the run read, by their recorded path, once each, in the order first read', () => {
    const built = facts([read('package.json'), read('src/a.ts'), read('Makefile'), read('package.json', 'cc'), write('src/b.ts'), pass('npm test'), pass('pytest')]);
    expect(built.map((fact) => fact.manifestPaths)).toEqual([
      [`${PROJECT}/package.json`, `${PROJECT}/Makefile`],
      [`${PROJECT}/package.json`, `${PROJECT}/Makefile`],
    ]);
  });

  it('builds no fact for a run that is not a verified success, whatever passed in it', () => {
    const cases: { steps: Step[]; status: string }[] = [
      { steps: [write('src/a.ts'), pass('npm test')], status: 'FAILED' },
      { steps: [write('src/a.ts'), pass('npm test')], status: 'CANCELLED' },
      { steps: [pass('npm test'), write('src/a.ts')], status: 'COMPLETED' },
      { steps: [write('src/a.ts'), pass('npm test'), fail('pytest')], status: 'COMPLETED' },
      { steps: [write('package.json'), pass('npm test')], status: 'COMPLETED' },
    ];
    for (const { steps, status } of cases) expect(facts(steps, status)).toEqual([]);
  });

  it('builds a fact exactly when the run is a verified success, over every journal of up to three steps', () => {
    const alphabet: Step[] = [write('src/a.ts'), write('package.json'), read('package.json'), pass('npm test'), fail('npm test'), pass('pytest'), pass('make check')];
    const journals: Step[][] = [[]];
    for (let length = 1; length <= 3; length += 1) {
      for (const prefix of journals.filter((steps) => steps.length === length - 1)) for (const step of alphabet) journals.push([...prefix, step]);
    }
    const isVerifiedSuccess = exported<(input: FactsInput) => boolean>('isVerifiedSuccess');
    for (const steps of journals) {
      for (const status of ['COMPLETED', 'FAILED']) {
        const input = { status, events: journal(steps), commands: COMMANDS, manifests: MANIFESTS };
        const built = repositoryFactsOf(input);
        expect(built.length > 0).toBe(isVerifiedSuccess(input));
        for (const fact of built) expect(fact.text).toBe(repositoryFactText(fact.command));
      }
    }
  });
});
