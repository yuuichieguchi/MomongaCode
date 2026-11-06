import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeLockPath } from '@momonga/gateway';

const specDir = path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'AutoProbe.tla'), 'utf8');
const config = fs.readFileSync(path.join(specDir, 'AutoProbe.cfg'), 'utf8');
const invariantTests = fs.readFileSync(path.join(import.meta.dirname, 'auto-probe.test.ts'), 'utf8');
const cliProbe = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'cli', 'src', 'commands', 'gateway.ts'), 'utf8');

const constantOf = (name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(config);
  if (match === null) throw new Error(`AutoProbe.cfg sets no ${name}`);
  return (match[1] as string).trim();
};

const invariantsOf = (): string[] => {
  const block = /INVARIANTS\n([\s\S]*?)\n\n/.exec(config);
  if (block === null) throw new Error('AutoProbe.cfg lists no invariants');
  return (block[1] as string).split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== 'TypeOK');
};

const PROPERTY_OF_INVARIANT: Record<string, string> = {
  SingleProbePerKey: 'P1',
  NoGuessedAnswer: 'P2',
  NoRecordGets503: 'P3',
  RetryAfterIsHonest: 'P3',
  RecordSeenAtOnce: 'P4',
  FailedWritesNothing: 'P5',
  RecordMatchesKey: 'P6',
  RecordIsClean: 'P7',
};

describe('the code conforms to specs/tla/AutoProbe.tla', () => {
  it('checks the design the code builds: a shared single-flight guard, the key per request, a fresh record, no guess, no 412, no record from a failure, the taint check, and the CLI writer as an actor', () => {
    expect({
      SingleFlight: constantOf('SingleFlight'),
      KeyView: constantOf('KeyView'),
      ReadRecord: constantOf('ReadRecord'),
      Guess: constantOf('Guess'),
      Reject412: constantOf('Reject412'),
      FailWrites: constantOf('FailWrites'),
      TaintCheck: constantOf('TaintCheck'),
      Manual: constantOf('Manual'),
    }).toEqual({
      SingleFlight: '"shared"',
      KeyView: '"perRequest"',
      ReadRecord: '"fresh"',
      Guess: 'FALSE',
      Reject412: 'FALSE',
      FailWrites: 'FALSE',
      TaintCheck: 'TRUE',
      Manual: 'TRUE',
    });
  });

  it('defines every invariant the check configuration lists, and each has a test named after it', () => {
    const invariants = invariantsOf();

    expect(invariants.sort()).toEqual(Object.keys(PROPERTY_OF_INVARIANT).sort());
    for (const name of invariants) {
      expect(spec).toMatch(new RegExp(`^${name} ==`, 'm'));
      expect(invariantTests).toContain(name);
      expect(invariantTests).toContain(`${PROPERTY_OF_INVARIANT[name]} `);
    }
  });

  it('keeps the shared guard in the file system beside the records, one lock per record key', () => {
    const dir = '/probe-records';
    const first = probeLockPath(dir, { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '25A1' });
    const otherBuild = probeLockPath(dir, { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '25A2' });
    const otherBinary = probeLockPath(dir, { target: 'fm', binarySha256: 'b'.repeat(64), osBuild: '25A1' });

    expect(path.dirname(first)).toBe(dir);
    expect(new Set([first, otherBuild, otherBinary]).size).toBe(3);
    expect(probeLockPath(dir, { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '25A1' })).toBe(first);
  });

  it('has the CLI writer, the actor Manual, go through the same guarded probe and restart no daemon to refresh a cached record', () => {
    const probeFm = /export const probeFm = [\s\S]*?\n};\n/.exec(cliProbe)?.[0];

    expect(probeFm).toBeDefined();
    expect(probeFm).toContain('probeManagedFm');
    expect(probeFm).not.toContain('restartDaemon');
  });

  it('names the code sources of the built design in the model header, not the cached record, the key at start or a lockless CLI', () => {
    const header = spec.slice(0, spec.indexOf('EXTENDS'));

    expect(header).toContain('gateway/src/probe/auto-probe.ts');
    expect(header).not.toMatch(/a cache that only|computed once at gateway start|It takes no lock/);
  });
});
