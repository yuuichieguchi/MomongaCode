import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, appendPermissionRule, loadMcpServers, loadSettings } from '@momonga/config';
import {
  localSettingsDir,
  localSettingsPath,
  makeDir,
  makeTree,
  mcpJsonPath,
  projectSettingsPath,
  repoLocalSettingsPath,
  trusting,
  userSettingsPath,
  writeJson,
  writeText,
} from './helpers.ts';

const load = (tree: ReturnType<typeof makeTree>) =>
  loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });

describe('B5 project additionalDirectories confinement', () => {
  it.each(['~', '..', '/'])('discards %j from project settings with a warning naming entry and file', async (entry) => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: [entry === '~' ? tree.home : entry] } });
    const result = await load(tree);
    expect(result.settings.permissions.additionalDirectories).toEqual([]);
    expect(result.warnings.some((w) => w.includes(file) && w.includes('additionalDirectories'))).toBe(true);
  });

  it('keeps project directories inside the project and user directories anywhere', async () => {
    const tree = makeTree();
    const inside = path.join(tree.project, 'inside');
    fs.mkdirSync(inside);
    writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: ['./inside'] } });
    writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: [tree.home] } });
    const result = await load(tree);
    expect(result.settings.permissions.additionalDirectories).toEqual([tree.home, inside]);
  });
});

describe('B6 project env hijack denylist', () => {
  const HIJACKS = [
    'BASH_ENV',
    'PATH',
    'HOME',
    'SHELL',
    'ENV',
    'ZDOTDIR',
    'PROMPT_COMMAND',
    'IFS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'GIT_SSH_COMMAND',
    'npm_config_prefix',
    'NPM_CONFIG_USERCONFIG',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'http_proxy',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'PYTHONPATH',
    'PERL5OPT',
    'RUBYOPT',
    'BUNDLE_GEMFILE',
    'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS',
    'DOTNET_STARTUP_HOOKS',
    'BASH_FUNC_x%%',
    'EDITOR',
    'PAGER',
    'TMPDIR',
  ];

  it.each(HIJACKS)('discards %s from project env with a warning but honors it from user settings', async (key) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { env: { [key]: 'user' } });
    const file = writeJson(projectSettingsPath(tree), { env: { [key]: 'evil', NODE_ENV: 'test' } });
    const result = await load(tree);
    expect(result.settings.env).toEqual({ [key]: 'user', NODE_ENV: 'test' });
    expect(result.warnings.some((w) => w.includes(key) && w.includes(file))).toBe(true);
  });
});

describe('B7 local settings live in user scope', () => {
  it('writes appended rules under the home directory and never inside the repository', async () => {
    const tree = makeTree();
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow' });
    expect(fs.existsSync(path.join(tree.project, '.momonga'))).toBe(false);
    expect(fs.statSync(localSettingsDir(tree)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(tree.home, '.momonga', 'projects')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(localSettingsPath(tree), 'utf8'))).toEqual({ permissions: { allow: ['Bash(ls)'] } });
  });

  it('ignores <project>/.momonga/settings.local.json with a warning', async () => {
    const tree = makeTree();
    const file = writeJson(repoLocalSettingsPath(tree), { permissions: { allow: ['Bash'] }, enableAllProjectMcpServers: true });
    const result = await load(tree);
    expect(result.rules).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.warnings.some((w) => w.includes(file) && /ignored/i.test(w))).toBe(true);
  });

  it('does not take MCP approvals from a repository-local settings file', async () => {
    const tree = makeTree();
    writeJson(repoLocalSettingsPath(tree), { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['x'] });
    writeJson(mcpJsonPath(tree), { mcpServers: { x: { command: 'x' } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval.map((s) => s.name)).toEqual(['x']);
  });
});

describe('B8 lock hardening', () => {
  const lockPathOf = (tree: ReturnType<typeof makeTree>): string => `${localSettingsPath(tree)}.lock`;

  it('times out naming the lock path and holder pid when a live process holds the lock', async () => {
    const tree = makeTree();
    writeText(lockPathOf(tree), String(process.pid));
    const failure = appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow', lockTimeoutMs: 200 });
    await expect(failure).rejects.toThrow(/timed out/);
    await expect(failure).rejects.toThrow(lockPathOf(tree));
    await expect(failure).rejects.toThrow(String(process.pid));
  });

  it('replaces a symlinked lock without touching its target', async () => {
    const tree = makeTree();
    const target = writeText(path.join(makeDir(), 'victim'), 'precious');
    fs.mkdirSync(localSettingsDir(tree), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, lockPathOf(tree));
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow' });
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(fs.existsSync(lockPathOf(tree))).toBe(false);
  });

  it('refuses a lock path that is a directory', async () => {
    const tree = makeTree();
    fs.mkdirSync(lockPathOf(tree), { recursive: true, mode: 0o700 });
    await expect(
      appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow', lockTimeoutMs: 200 }),
    ).rejects.toThrow(/not a regular file/);
  });
});

describe('S6 credential variables in project .mcp.json', () => {
  it('refuses to expand credential-looking variables in project servers', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { gh: { command: 'gh-mcp', env: { T: '${GITHUB_TOKEN}' } }, ok: { command: 'ok' } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { GITHUB_TOKEN: 'secret' } });
    expect(result.enabled.map((s) => s.name)).toEqual(['ok']);
    expect(result.pendingApproval).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.warnings.filter((w) => w.includes('"gh"') && w.includes('GITHUB_TOKEN'))).toHaveLength(1);
  });

  it('refuses variables named by apiKeyEnv in user model targets', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      enableAllProjectMcpServers: true,
      models: {
        targets: {
          m: {
            adapter: 'chat-completions',
            model: 'x',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'ACME_CRED',
            capabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
          },
        },
        aliases: { default: 'm' },
      },
    });
    writeJson(mcpJsonPath(tree), { mcpServers: { s: { command: 's', args: ['${ACME_CRED}'] } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { ACME_CRED: 'v' } });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('"s"') && w.includes('ACME_CRED'))).toHaveLength(1);
  });

  it('still lets user-scope servers expand credentials', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { gh: { command: 'gh-mcp', env: { T: '${GITHUB_TOKEN}' } } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { GITHUB_TOKEN: 's' } });
    expect(result.enabled[0]?.config).toMatchObject({ env: { T: 's' } });
  });

  it('throws ConfigError for an invalid expansion in a user-scope server', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { gh: { command: 'gh-mcp', args: ['${1BAD}'] } } });
    const failure = loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow('"gh"');
  });
});

describe('N1 prototype-pollution keys', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('rejects %s in settings naming file and pointer', async (key) => {
    const tree = makeTree();
    const file = writeText(userSettingsPath(tree), `{"env": {"${key}": "x"}}`);
    const failure = load(tree);
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(`/env/${key}`);
  });

  it('rejects __proto__ in .mcp.json', async () => {
    const tree = makeTree();
    const file = writeText(mcpJsonPath(tree), '{"mcpServers": {"a": {"command": "x", "__proto__": {"polluted": true}}}}');
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((w) => w.includes(file) && w.includes('/mcpServers/a/__proto__'))).toHaveLength(1);
  });
});

describe('N2 file type checks', () => {
  it('refuses a FIFO as project settings', async () => {
    const tree = makeTree();
    const file = projectSettingsPath(tree);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('mkfifo', [file]);
    await expect(load(tree)).rejects.toThrow(/not a regular file/);
  });

  it('refuses a repository settings symlink that points outside the project', async () => {
    const tree = makeTree();
    const outside = writeJson(path.join(makeDir(), 'outside.json'), { autoUpdates: false });
    const file = projectSettingsPath(tree);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(outside, file);
    await expect(load(tree)).rejects.toThrow(/outside the project/);
  });

  it('refuses a .mcp.json symlink that points outside the project with a warning', async () => {
    const tree = makeTree();
    const outside = writeJson(path.join(makeDir(), 'm.json'), { mcpServers: { a: { command: 'a' } } });
    fs.symlinkSync(outside, mcpJsonPath(tree));
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((w) => w.includes(mcpJsonPath(tree)) && /outside the project/.test(w))).toHaveLength(1);
  });

  it('accepts a user settings symlink to a regular file', async () => {
    const tree = makeTree();
    const real = writeJson(path.join(makeDir(), 'real.json'), { autoUpdates: false });
    fs.mkdirSync(path.dirname(userSettingsPath(tree)), { recursive: true });
    fs.symlinkSync(real, userSettingsPath(tree));
    expect((await load(tree)).settings.autoUpdates).toBe(false);
  });
});

describe('F4 project env allowlist', () => {
  const ALLOWED = ['NODE_ENV', 'RUST_LOG', 'RUST_BACKTRACE', 'LOG_LEVEL', 'DEBUG', 'TZ', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'TERM'];
  const REJECTED = ['XDG_CONFIG_HOME', 'GOFLAGS', 'RUSTC_WRAPPER', 'CARGO_HOME', 'GCONV_PATH', 'SUDO_ASKPASS', 'CLASSPATH', 'PIP_INDEX_URL', 'GEM_HOME', 'MAKEFLAGS', 'BROWSER', 'HISTFILE', 'NODE_PATH', 'LC_', 'LCX_ALL', 'lang'];

  it.each(['project', 'local'] as const)('keeps only allowlisted env keys from %s settings and warns about the rest', async (layer) => {
    const tree = makeTree();
    const env = Object.fromEntries([...ALLOWED, ...REJECTED].map((key) => [key, 'v']));
    const file = writeJson(layer === 'project' ? projectSettingsPath(tree) : localSettingsPath(tree), { env });
    const result = await load(tree);
    expect(Object.keys(result.settings.env).sort()).toEqual([...ALLOWED].sort());
    for (const key of REJECTED) expect(result.warnings.some((w) => w.includes(key) && w.includes(file))).toBe(true);
  });

  it('leaves user env unrestricted', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { env: { GOFLAGS: '-mod=mod', XDG_CONFIG_HOME: '/x' } });
    expect((await load(tree)).settings.env).toEqual({ GOFLAGS: '-mod=mod', XDG_CONFIG_HOME: '/x' });
  });
});

describe('S6 follow-up: sensitive variable names in project .mcp.json', () => {
  it.each(['DATABASE_URL', 'SENTRY_DSN', 'GH_PAT', 'DB_CONN', 'MY_SESSION', 'MY_COOKIE', 'MY_CREDENTIALS'])('refuses to expand %s', async (variable) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { s: { command: 's', args: [`\${${variable}}`] } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { [variable]: 'v' } });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('"s"') && w.includes(variable))).toHaveLength(1);
  });
});
