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
  causes: string[];
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

  it('names every cause of the constants, and the causes the model has beyond them are the evidence-only transient and the undecided candidate unusable_response', () => {
    const modelledCauses = setDefinitionOf(credentialSpec, 'Causes');
    const known = [...constants.terminalCodes, ...constants.causes];
    expect(constants.causes.filter((cause) => !modelledCauses.includes(cause))).toEqual([]);
    expect(without(modelledCauses, [...known, 'none'])).toEqual(['transient', 'unusable_response']);
  });

  it('leaves invalid_client out of the model, as the model states', () => {
    expect(credentialSpec).toMatch(/invalid_client and the state plan_disabled are not modelled/);
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
