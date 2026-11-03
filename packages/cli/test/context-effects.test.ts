import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFiles } from '../src/node-ports.ts';
import { OWNER_FILE, ROOT_PREFIX, caseEnvironment } from '../src/eval/context-host.ts';
import { copyProbeRecord, listEvalRoots, nodeContextEffects, readEvalOwner } from '../src/eval/context-effects.ts';
import type { CliPorts } from '../src/ports.ts';

const directories: string[] = [];

const locked: string[] = [];

const temporary = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-probe-test-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of locked.splice(0)) fs.chmodSync(directory, 0o700);
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('the homes a sweep may consider', () => {
  const ownerUid = process.getuid?.() ?? 0;

  it('lists only real directories that this user owns and that carry the product prefix', async () => {
    const base = temporary();
    const own = path.join(base, `${ROOT_PREFIX}own`);
    fs.mkdirSync(own);
    fs.mkdirSync(path.join(base, 'mc-legacy'));
    fs.mkdirSync(path.join(base, 'unrelated'));
    fs.writeFileSync(path.join(base, `${ROOT_PREFIX}file`), '');
    fs.symlinkSync(own, path.join(base, `${ROOT_PREFIX}link`));
    expect(await listEvalRoots(base, ownerUid)).toEqual([own]);
  });

  it('skips a directory that another user owns', async () => {
    const base = temporary();
    fs.mkdirSync(path.join(base, `${ROOT_PREFIX}theirs`));
    expect(await listEvalRoots(base, ownerUid + 1)).toEqual([]);
  });

  it('reads the owner marker of a home, and says nothing when there is none', async () => {
    const root = temporary();
    expect(await readEvalOwner(nodeFiles, root)).toBeUndefined();
    fs.writeFileSync(path.join(root, OWNER_FILE), '4242');
    expect(await readEvalOwner(nodeFiles, root)).toBe(4242);
  });

  it('reports a directory it cannot read as unreadable instead of throwing', async () => {
    const root = temporary();
    fs.chmodSync(root, 0o000);
    locked.push(root);
    expect(await readEvalOwner(nodeFiles, root)).toBe('unreadable');
  });

  it('reports a plain file that has the prefix as unreadable instead of throwing', async () => {
    const base = temporary();
    const file = path.join(base, `${ROOT_PREFIX}file`);
    fs.writeFileSync(file, '');
    expect(await readEvalOwner(nodeFiles, file)).toBe('unreadable');
  });
});

describe('the environment of a session inside a case', () => {
  const portsWith = (home: string, env: Record<string, string>): CliPorts => ({ platform: 'linux', env, home, files: nodeFiles }) as unknown as CliPorts;

  const personEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin',
    HOME: '/home/person',
    XDG_CACHE_HOME: '/home/person/.cache',
    XDG_DATA_HOME: '/home/person/.local/share',
    XDG_CONFIG_HOME: '/home/person/.config',
    XDG_STATE_HOME: '/home/person/.local/state',
    APPDATA: '/home/person/AppData/Roaming',
    LOCALAPPDATA: '/home/person/AppData/Local',
    UPSTREAM_VARIABLE: 'declared-value',
    UPSTREAM_KEY: 'key-value',
  };

  const personHome = (): string => {
    const home = temporary();
    const settingsFile = path.join(home, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        models: {
          aliases: { default: ['t'] },
          targets: { t: { adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', apiKeyEnv: 'UPSTREAM_VARIABLE', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } },
        },
      }),
    );
    return home;
  };

  it('is built by the function that builds the environment of the case daemon, with the case home, no relocated cache and no credential', async () => {
    const root = temporary();
    const ports = portsWith(personHome(), personEnv);
    const env = await nodeContextEffects(ports).sessionEnv(root);
    expect(env['HOME']).toBe(root);
    for (const name of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'UPSTREAM_KEY', 'UPSTREAM_VARIABLE']) {
      expect(env).not.toHaveProperty(name);
    }
    const daemon = caseEnvironment(personEnv, root, 'linux');
    expect({ ...env, ...Object.fromEntries(['UPSTREAM_KEY', 'UPSTREAM_VARIABLE'].map((name) => [name, daemon[name]])) }).toEqual(daemon);
  });

  it('is what a shell command in the case sees: the home of the case, never the home of the person', async () => {
    const root = fs.realpathSync(temporary());
    const env = await nodeContextEffects(portsWith(personHome(), personEnv)).sessionEnv(root);
    const seen = execFileSync('/bin/bash', ['-c', 'printf %s "$HOME"'], { env }).toString();
    expect(seen).toBe(root);
  });
});

describe('copyProbeRecord', () => {
  const record = JSON.stringify({ binarySha256: 'a'.repeat(64), osBuild: '25A1', report: { anything: true } });

  it('copies the record of a target byte for byte, keyed by the same name', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'state', 'probe');
    fs.writeFileSync(path.join(from, 'system.json'), record);
    expect(await copyProbeRecord(nodeFiles, from, to, 'system')).toBe(true);
    expect(fs.readFileSync(path.join(to, 'system.json'), 'utf8')).toBe(record);
    expect(fs.statSync(path.join(to, 'system.json')).mode & 0o777).toBe(0o600);
  });

  it('copies nothing when the person never probed the target, so the case sees the same answer', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'probe');
    expect(await copyProbeRecord(nodeFiles, from, to, 'system')).toBe(false);
    expect(fs.existsSync(to)).toBe(false);
  });
});
