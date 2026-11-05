import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRule } from '@momonga/config';
import * as policy from '@momonga/policy';
import { commandMatchStrength } from '../src/command-match.ts';
import { commandSpecsFor } from '../src/platform-specs.ts';

const PLATFORMS = ['darwin', 'linux'] as const;

type SpecFields = {
  names: readonly string[];
  operands: string;
  approval?: string;
  extractor?: string;
  payload?: string;
  wrapper?: unknown;
  options: readonly { name: string; effect: string; setsOperandRole?: string }[];
  operandsAreData?: boolean;
  sourcesAreText?: boolean;
  singleOperandDestination?: string;
  defaultOperand?: string;
};

const specOf = (platform: (typeof PLATFORMS)[number], name: string): SpecFields => {
  const spec = commandSpecsFor(platform).specOf(name);
  if (spec === undefined) throw new Error(`${platform} has no spec for ${name}`);
  return spec as unknown as SpecFields;
};

const allSpecs = (platform: (typeof PLATFORMS)[number]): SpecFields[] => commandSpecsFor(platform).all as unknown as SpecFields[];

const rmDeny = parseRule('Bash(rm:*)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: '/p', home: '/h', cwd: '/p' });

describe.each(PLATFORMS)('the spec table on %s declares what the shared extractors used to branch on by name', (platform) => {
  it('declares printf with no approval and with the property its man page states', () => {
    const printf = specOf(platform, 'printf');
    expect(printf.names).toContain('printf');
    expect(printf.approval).toBeUndefined();
    expect(printf.operandsAreData).toBe(true);
  });

  it('declares operandsAreData on echo', () => {
    expect(specOf(platform, 'echo').operandsAreData).toBe(true);
  });

  it('declares that ln stores its sources as text and names the destination in the working directory for a single operand', () => {
    const ln = specOf(platform, 'ln');
    expect(ln.operands).toBe('copy');
    expect(ln.sourcesAreText).toBe(true);
    expect(ln.singleOperandDestination).toBe('working-directory');
    expect(ln.extractor).toBeUndefined();
  });

  it('declares that install -d makes every operand a written operand', () => {
    const install = specOf(platform, 'install');
    expect(install.operands).toBe('copy');
    expect(install.extractor).toBeUndefined();
    expect(install.options.find((option) => option.name === '-d')?.setsOperandRole).toBe('write-all');
  });

  it('declares that cd reads home with no operand and that popd takes no target, while pushd keeps its operands', () => {
    expect(specOf(platform, 'cd').defaultOperand).toBe('home');
    expect(specOf(platform, 'popd').operands).toBe('none');
    expect(specOf(platform, 'pushd').operands).toBe('read-all');
  });

  it('keeps every operandsAreData program free of wrappers, payloads, exec or opens-path options and operand roles', () => {
    const printers = allSpecs(platform).filter((spec) => spec.operandsAreData === true);
    expect(printers.flatMap((spec) => spec.names).sort()).toEqual(['echo', 'printf']);
    for (const spec of printers) {
      expect(spec.wrapper, spec.names.join()).toBeUndefined();
      expect(spec.payload, spec.names.join()).toBeUndefined();
      expect(spec.operands, spec.names.join()).toBe('none');
      expect(spec.options.filter((option) => option.effect === 'exec' || option.effect === 'opens-path'), spec.names.join()).toEqual([]);
    }
  });

  it('derives the inert printers from the table', () => {
    const derive = (policy as unknown as { inertPrinterSet?: (specs: unknown) => ReadonlySet<string> }).inertPrinterSet;
    expect(typeof derive).toBe('function');
    expect([...(derive?.(commandSpecsFor(platform)) ?? [])].sort()).toEqual(['echo', 'printf']);
  });

  it('does not let printf rm -rf / match a Bash(rm:*) deny rule incidentally, because printf is in the table by property', () => {
    expect(specOf(platform, 'printf').operandsAreData).toBe(true);
    expect(commandMatchStrength(rmDeny, 'printf rm -rf /')).toBeNull();
    expect(commandMatchStrength(rmDeny, 'rm -rf /')).toBe('position');
  });
});

describe('the SMT command model reads the same derived set as the matcher', () => {
  it('no longer exports a hard-coded INERT_PRINTERS', () => {
    expect(Object.keys(policy)).not.toContain('INERT_PRINTERS');
  });

  it('builds the printer language of verify/src/command-model.ts from inertPrinterSet', () => {
    const model = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'verify', 'src', 'command-model.ts'), 'utf8');
    expect(model).toMatch(/\binertPrinterSet\(/);
    expect(model).not.toMatch(/\bINERT_PRINTERS\b/);
  });
});
