import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV, SECRET_REFUSAL_ENV, secretStoreEnvFor } from '@momonga/foundation';
import { programOwnerProblemSync } from '@momonga/foundation/program-search';
import type { ProgramOwnerFiles } from '@momonga/foundation/program-search';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const binDirWith = (...programs: string[]): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-secret-trust-')));
  tempDirs.push(dir);
  for (const program of programs) fs.writeFileSync(path.join(dir, program), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
};

const PERSON = 501;
const OTHER = 777;
const ROOT = 0;
const DIRECTORY = 0o040000;
const FILE = 0o100000;

type Entry = { uid: number; mode: number };

const filesOf = (entries: Readonly<Record<string, Entry>>): ProgramOwnerFiles => ({
  lstatSync: (file) => {
    const entry = entries[file];
    if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return { uid: entry.uid, mode: entry.mode, isSymbolicLink: () => false, isDirectory: () => (entry.mode & DIRECTORY) !== 0 } as fs.Stats;
  },
  realpathSync: (file) => file,
});

const chain = (overrides: Readonly<Record<string, Entry>>): ProgramOwnerFiles =>
  filesOf({
    '/': { uid: ROOT, mode: DIRECTORY | 0o755 },
    '/opt': { uid: ROOT, mode: DIRECTORY | 0o755 },
    '/opt/bin': { uid: ROOT, mode: DIRECTORY | 0o755 },
    '/opt/bin/security': { uid: ROOT, mode: FILE | 0o755 },
    ...overrides,
  });

const host = (platform: NodeJS.Platform): { platform: NodeJS.Platform; uid: number | undefined } => ({ platform, uid: process.getuid?.() });

describe('a secret program is trusted only when no other account can change it or its folders', () => {
  it('accepts a program owned by root in folders owned by root', () => {
    expect(programOwnerProblemSync('/opt/bin/security', chain({}), PERSON)).toBeUndefined();
  });

  it('accepts a program the person owns, whatever its mode', () => {
    expect(programOwnerProblemSync('/opt/bin/security', chain({ '/opt/bin/security': { uid: PERSON, mode: FILE | 0o777 } }), PERSON)).toBeUndefined();
  });

  it('refuses a program in a folder another account owns, with a sentence that names the folder and the rule', () => {
    const problem = programOwnerProblemSync('/opt/bin/security', chain({ '/opt/bin': { uid: OTHER, mode: DIRECTORY | 0o755 } }), PERSON);
    expect(problem).toContain('/opt/bin');
    expect(problem).toMatch(/owned by you or root/);
  });

  it('refuses a program in a root folder that any account can write', () => {
    expect(programOwnerProblemSync('/opt/bin/security', chain({ '/opt/bin': { uid: ROOT, mode: DIRECTORY | 0o777 } }), PERSON)).toContain('/opt/bin');
  });

  it('accepts a sticky folder that any account can write when the entry below it is the person\'s or root\'s', () => {
    expect(programOwnerProblemSync('/opt/bin/security', chain({ '/opt': { uid: ROOT, mode: DIRECTORY | 0o1777 } }), PERSON)).toBeUndefined();
  });
});

describe('the secret backend is chosen by the platform', () => {
  it('never uses a relative PATH entry', () => {
    const bin = binDirWith('security');
    const env = secretStoreEnvFor({ PATH: path.relative(process.cwd(), bin) }, host('darwin'));
    expect(env[SECRET_BACKEND_ENV]).toBeUndefined();
    expect(env[SECRET_REFUSAL_ENV]).toMatch(/security \(Keychain\) is not on PATH/);
  });

  it('does not use the Keychain on Linux when a security program is on PATH', () => {
    const bin = binDirWith('security', 'secret-tool');
    const env = secretStoreEnvFor({ PATH: bin, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, host('linux'));
    expect(env[SECRET_BACKEND_ENV]).toBe('secret-service');
    expect(env[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'secret-tool'));
  });

  it('does not use the Secret Service on macOS when secret-tool is on PATH', () => {
    const bin = binDirWith('secret-tool');
    const env = secretStoreEnvFor({ PATH: bin, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, host('darwin'));
    expect(env[SECRET_BACKEND_ENV]).toBeUndefined();
  });

  it('refuses a program whose folder another account owns, with the sentence', () => {
    const bin = binDirWith('security');
    const env = secretStoreEnvFor({ PATH: bin }, { platform: 'darwin', uid: (process.getuid?.() ?? 0) + 1 });
    expect(env[SECRET_BACKEND_ENV]).toBeUndefined();
    expect(env[SECRET_REFUSAL_ENV]).toMatch(/owned by you or root/);
  });
});
