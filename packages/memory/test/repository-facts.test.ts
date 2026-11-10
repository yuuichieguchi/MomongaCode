import { describe, expect, it } from 'vitest';
import { isVerifiedSuccess, repositoryFactText, repositoryFactsOf } from '@momonga/memory';
import { PROJECT, bash, check, journal, read, requested, seqOfCheck, standing, write } from './verdict-journal.ts';
import type { Condition, Step } from './verdict-journal.ts';

const COMMANDS = ['npm test', 'npm run lint'];
const MANIFESTS = ['package.json', 'Makefile'];
const STANDING = COMMANDS.map(standing);

const eventsOf = (steps: readonly Step[], conditions: readonly Condition[] = STANDING) => journal(conditions, steps);

const facts = (steps: readonly Step[], status = 'COMPLETED', conditions: readonly Condition[] = STANDING) =>
  repositoryFactsOf({ status, events: eventsOf(steps, conditions), commands: COMMANDS, manifests: MANIFESTS });

const pass = (): Step[] => [check('npm run lint'), check('npm test')];

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
  it('builds one procedure fact per passed standing condition, in the order of the verdicts, each bound to its verdict', () => {
    const steps = [write('src/a.ts'), ...pass()];
    const events = eventsOf(steps);
    expect(facts(steps)).toEqual([
      { command: 'npm run lint', text: 'Run `npm run lint` to verify a change in this repository.', kind: 'procedure', check: { conditionId: 'c:npm run lint', seq: seqOfCheck(events, 'npm run lint') }, manifestPaths: [] },
      { command: 'npm test', text: 'Run `npm test` to verify a change in this repository.', kind: 'procedure', check: { conditionId: 'c:npm test', seq: seqOfCheck(events, 'npm test') }, manifestPaths: [] },
    ]);
  });

  it('gives no fact for a command the model ran itself, whatever it exited with', () => {
    expect(facts([write('src/a.ts'), bash('npm test'), bash('npm run lint')])).toEqual([]);
  });

  it('gives no fact for a passed condition that is not a command of the settings', () => {
    const conditions = [...STANDING, requested('make check')];
    expect(facts([write('src/a.ts'), ...pass(), check('make check')], 'COMPLETED', conditions).map((fact) => fact.command)).toEqual(['npm run lint', 'npm test']);
  });

  it('names the manifests the run read, by their recorded path, once each, in the order first read', () => {
    const built = facts([read('package.json'), read('src/a.ts'), read('Makefile'), read('package.json', 'cc'), write('src/b.ts'), ...pass()]);
    expect(built.map((fact) => fact.manifestPaths)).toEqual([
      [`${PROJECT}/package.json`, `${PROJECT}/Makefile`],
      [`${PROJECT}/package.json`, `${PROJECT}/Makefile`],
    ]);
  });

  it('builds no fact for a run that is not a verified success, whatever passed in it', () => {
    const cases: { steps: Step[]; status: string }[] = [
      { steps: [write('src/a.ts'), ...pass()], status: 'FAILED' },
      { steps: [write('src/a.ts'), ...pass()], status: 'CANCELLED' },
      { steps: [write('src/a.ts'), ...pass(), write('src/b.ts')], status: 'COMPLETED' },
      { steps: [write('src/a.ts'), ...pass(), check('npm test', 'failed')], status: 'COMPLETED' },
      { steps: [write('src/a.ts'), check('npm test')], status: 'COMPLETED' },
      { steps: [write('package.json'), ...pass()], status: 'COMPLETED' },
    ];
    for (const { steps, status } of cases) expect(facts(steps, status)).toEqual([]);
  });

  it('builds a fact exactly when the run is a verified success, over every journal of up to three steps', () => {
    const alphabet: Step[] = [write('src/a.ts'), write('package.json'), read('package.json'), check('npm test'), check('npm test', 'failed'), check('npm run lint'), bash('npm test')];
    const journals: Step[][] = [[]];
    for (let length = 1; length <= 3; length += 1) {
      for (const prefix of journals.filter((steps) => steps.length === length - 1)) for (const step of alphabet) journals.push([...prefix, step]);
    }
    for (const steps of journals) {
      for (const status of ['COMPLETED', 'FAILED']) {
        const input = { status, events: eventsOf(steps), commands: COMMANDS, manifests: MANIFESTS };
        const built = repositoryFactsOf(input);
        expect(built.length > 0).toBe(isVerifiedSuccess(input));
        for (const fact of built) expect(fact.text).toBe(repositoryFactText(fact.command));
      }
    }
  });
});
