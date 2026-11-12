import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const credentialSpec = fs.readFileSync(path.join(root, 'specs', 'tla', 'PlanCredential.tla'), 'utf8');
const signInSpec = fs.readFileSync(path.join(root, 'specs', 'tla', 'PlanSignIn.tla'), 'utf8');
const constantsPath = path.join(root, 'packages', 'protocol', 'src', 'plan-constants.json');

type PlanConstants = {
  credentialStates: string[];
  terminalCodes: string[];
  configurationCodes: string[];
  flags: string[];
};

const readConstants = (): PlanConstants => JSON.parse(fs.readFileSync(constantsPath, 'utf8')) as PlanConstants;

const setDefinitionOf = (spec: string, name: string): string[] => {
  const line = new RegExp(`^${name} ==(.*)$`, 'm').exec(spec);
  if (line === null) throw new Error(`${name} is not defined as a set on one line`);
  return [...(line[1] as string).matchAll(/"([^"]+)"/g)].map((string) => string[1] as string);
};

const without = (values: readonly string[], removed: readonly string[]): string[] => values.filter((value) => !removed.includes(value)).sort();

describe('plan-constants.json', () => {
  const constants = readConstants();

  it('has no duplicate and no empty list', () => {
    for (const [name, values] of Object.entries(constants)) {
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
    }
  });

  it('names the store failure states of the design beside the lifecycle states', () => {
    expect(constants.credentialStates).toContain('store_unwritable');
    expect(constants.credentialStates).toContain('store_unreadable');
  });

  it('keeps the terminal refresh codes and the configuration code apart', () => {
    expect(constants.terminalCodes).toHaveLength(6);
    expect(constants.configurationCodes).toEqual(['invalid_client']);
    expect(constants.terminalCodes.filter((code) => constants.configurationCodes.includes(code))).toEqual([]);
  });
});

describe('PlanCredential.tla against plan-constants.json', () => {
  const constants = readConstants();

  it('names a subset of the credential states, and the remainder is the two the model does not hold as a record state', () => {
    const modelled = setDefinitionOf(credentialSpec, 'AcctStates');
    expect(modelled.filter((state) => !constants.credentialStates.includes(state))).toEqual([]);
    expect(without(constants.credentialStates, modelled)).toEqual(['plan_disabled', 'store_unwritable']);
  });

  it('holds store_unwritable as the memory flag mUnwr and leaves plan_disabled to PlanSignIn', () => {
    expect(credentialSpec).toMatch(/store_unwritable/);
    expect(credentialSpec).toMatch(/\bmUnwr\b/);
    expect(setDefinitionOf(credentialSpec, 'AcctStates')).not.toContain('store_unwritable');
    expect(setDefinitionOf(signInSpec, 'RecStates')).toContain('plan_disabled');
  });

  it('names a subset of the terminal codes, and the remainder is the three codes the model collapses into them', () => {
    const modelled = setDefinitionOf(credentialSpec, 'TerminalCodes');
    expect(modelled.filter((code) => !constants.terminalCodes.includes(code))).toEqual([]);
    expect(without(constants.terminalCodes, modelled)).toEqual(['invalid_refresh_token', 'refresh_token_expired', 'token_expired']);
  });

  it('states the product flags as the model flag set, and every other cause of the model is named evidence-only', () => {
    expect(setDefinitionOf(credentialSpec, 'Flags').sort()).toEqual([...constants.flags].sort());
    const modelledCauses = setDefinitionOf(credentialSpec, 'Causes');
    const evidenceOnly = setDefinitionOf(credentialSpec, 'EvidenceOnlyCauses');
    expect(evidenceOnly.sort()).toEqual(['refresh_interrupted', 'transient']);
    expect(without(modelledCauses, [...constants.terminalCodes, ...evidenceOnly, 'none'])).toEqual([]);
    expect(evidenceOnly.filter((cause) => constants.terminalCodes.includes(cause) || constants.flags.includes(cause))).toEqual([]);
  });

  it('leaves invalid_client out of the model, as the model states', () => {
    expect(credentialSpec).toMatch(/invalid_client and the state plan_disabled are not modelled/);
  });
});

describe('PlanCredential.tla against the sign-out resume of the plan session', () => {
  const session = fs.readFileSync(path.join(root, 'packages', 'gateway', 'src', 'plan', 'session.ts'), 'utf8');

  const RESUME_ROWS = [
    { model: 'SoAbort', defined: /^SoAbort\(a\) ==$/m, code: 'unloadForResume', what: 'a sign-out that ends without the cleared record drops the memory copy' },
    { model: 'SoReload', defined: /^SoReload\(a\) ==$/m, code: 'resumeSignOut', what: 'a record read as signing_out schedules the resumed sign-out' },
    { model: 'SigningOutResolves', defined: /^SigningOutResolves ==/m, code: 'unfinishedSignOutOf', what: 'the resumed sign-out acts on the record it finds under the lock' },
    { model: 'SoGrantFails', defined: /^SoGrantFails\(a\) ==$/m, code: 'signOutWith', what: 'a transient failure of the signing_out write ends the sign-out with the record unchanged' },
  ] as const;

  it.each(RESUME_ROWS)('$model is defined in the model and $code in the session: $what', ({ defined, code }) => {
    expect(credentialSpec).toMatch(defined);
    expect(session).toMatch(new RegExp(`\\b(?:const|function) ${code}\\b`));
  });

  it('the resumed sign-out asks the in-lock check before it sends or writes anything', () => {
    const body = /const signOutWith = [\s\S]*?\n {2}const runSignOut = /.exec(session)?.[0] ?? '';
    expect(body).toMatch(/unfinishedSignOutOf\(account\)/);
    expect(body.indexOf('unfinishedSignOutOf(account)')).toBeLessThan(body.indexOf('signOutUnderLock('));
  });

  it('every record that enters memory from the store schedules the resume in one place', () => {
    expect([...session.matchAll(/resumeSignOut\(account\)/g)]).toHaveLength(1);
  });
});

describe('PlanSignIn.tla against plan-constants.json', () => {
  const constants = readConstants();

  it('holds its record states in the credential states, absent apart', () => {
    const recordStates = setDefinitionOf(signInSpec, 'RecStates');
    expect(recordStates).toContain('absent');
    expect(constants.credentialStates).not.toContain('absent');
    expect(recordStates.filter((state) => state !== 'absent' && !constants.credentialStates.includes(state))).toEqual([]);
  });

  it('leaves the lifecycle and store states to PlanCredential', () => {
    const recordStates = setDefinitionOf(signInSpec, 'RecStates');
    expect(without(constants.credentialStates, recordStates)).toEqual(['needs_sign_in', 'signing_out', 'store_unreadable', 'store_unwritable']);
  });
});

describe('PlanCredential.tla: a transient persist failure never signs an account out', () => {
  it('defines TransientNeverSignsOut, and the evidence transientSignsOut violates it', () => {
    expect(credentialSpec).toMatch(/^TransientNeverSignsOut ==/m);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'specs', 'tla', 'manifest.json'), 'utf8')) as { entries: { config: string; expect: unknown }[] };
    expect(manifest.entries.find((entry) => entry.config === 'PlanCredential.transientSignsOut')?.expect).toEqual({ violates: 'TransientNeverSignsOut', exitCode: 12 });
  });
});


describe('PlanCredential.tla cites code lines that hold what it names', () => {
  const lineOf = (file: string, line: number): string => fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1] ?? '';
  const header = credentialSpec.slice(0, credentialSpec.indexOf('EXTENDS'));

  const CITATIONS: readonly (readonly [string, number, string, string])[] = [
    ['packages/gateway/src/plan/session.ts', 795, 'await writeRecord(account, entry, intent, signal)', 'session.ts:795-799'],
    ['packages/gateway/src/plan/session.ts', 797, 'markWriteFailure(account, error, signal)', 'session.ts:795-799'],
    ['packages/gateway/src/plan/session.ts', 941, 'await writeRecord(account, entry, signingOut, signal)', 'packages/gateway/src/plan/session.ts:941'],
    ['packages/gateway/src/plan/session.ts', 947, ': await revokeRefreshToken({', 'session.ts:947-962'],
    ['packages/gateway/src/plan/session.ts', 962, 'await writeRecord(account, entry, cleared, signal)', 'session.ts:947-962'],
  ];

  it.each(CITATIONS)('%s:%i holds %s and the header cites it as %s', (file, line, text, cited) => {
    expect(lineOf(file, line), `${file}:${line}`).toContain(text);
    expect(header).toContain(cited);
  });

  it('says that the intent write before a refresh can fail and that its failure sends nothing', () => {
    expect(header).not.toMatch(/intent write before a refresh cannot fail/);
    expect(header.replace(/\(\*|\*\)/g, ' ').replace(/\s+/g, ' ')).toMatch(/A failure of the intent write before a refresh is not a step of the model/);
  });
});
