import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const SCRIPT = `${repoRoot}scripts/install.ps1`;

const doubleQuotedStrings = (source: string): string[] => [...source.matchAll(/"((?:[^"`]|`.)*)"/g)].map((match) => match[1] as string);

const VARIABLE_FOLLOWED_BY_COLON = /\$(?:env:)?[A-Za-z_]\w*:(?![:\w])/;

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
const pwshAvailable = pwsh.error === undefined && pwsh.status === 0;

describe('install.ps1', () => {
  it('never puts a colon directly after a variable name inside a double-quoted string, where PowerShell reads it as a scope or drive qualifier', () => {
    const offenders = doubleQuotedStrings(fs.readFileSync(SCRIPT, 'utf8')).filter((text) => VARIABLE_FOLLOWED_BY_COLON.test(text));
    expect(offenders).toEqual([]);
  });

  it('detects the hazard it guards against', () => {
    expect(VARIABLE_FOLLOWED_BY_COLON.test('unsupported architecture $env:PROCESSOR_ARCHITECTURE: only x64')).toBe(true);
    expect(VARIABLE_FOLLOWED_BY_COLON.test('unsupported architecture ${env:PROCESSOR_ARCHITECTURE}: only x64')).toBe(false);
    expect(VARIABLE_FOLLOWED_BY_COLON.test('path $env:LOCALAPPDATA')).toBe(false);
  });

  it('fails clearly, and says what to do, when no release key is pinned', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("$embeddedReleasePublicKey = ''");
    expect(source).toContain('this installer pins no release signing key');
    expect(source).toContain('set MOMONGA_RELEASE_PUBLIC_KEY to the ssh public key line the maintainers publish');
  });

  it('declares the release repository yuuichieguchi/MomongaCode right after the embedded release public key', () => {
    const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
    const keyLine = lines.indexOf("$embeddedReleasePublicKey = ''");
    expect(keyLine).toBeGreaterThanOrEqual(0);
    expect(lines[keyLine + 1]).toBe("$embeddedReleaseRepo = 'yuuichieguchi/MomongaCode'");
  });

  it('embeds the same release repository as install.sh', () => {
    const shell = /^readonly EMBEDDED_RELEASE_REPO="([^"\n]*)"$/m.exec(fs.readFileSync(`${repoRoot}scripts/install.sh`, 'utf8'))?.[1];
    const powershell = /^\$embeddedReleaseRepo = '([^'\n]*)'$/m.exec(fs.readFileSync(SCRIPT, 'utf8'))?.[1];
    expect(shell).toBe('yuuichieguchi/MomongaCode');
    expect(powershell).toBe(shell);
  });

  it('builds the download URL from the embedded repository, with MOMONGA_REPO only as an override', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).not.toContain('if (-not $env:MOMONGA_REPO)');
    expect(source.match(/\$embeddedReleaseRepo\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const urlLines = source.split('\n').filter((line) => line.includes('https://github.com/'));
    expect(urlLines.length).toBe(2);
    for (const line of urlLines) expect(line).not.toContain('$env:MOMONGA_REPO');
  });

  it('refuses plain http to anything but the loopback interface', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("-notmatch '^https://'");
    expect(source).toContain('(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?(/|$)');
  });

  it.runIf(pwshAvailable)('parses without errors under PowerShell', () => {
    const parse = spawnSync(
      'pwsh',
      ['-NoProfile', '-Command', `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$errors) | Out-Null; $errors | ForEach-Object { $_.Message }; exit $errors.Count`],
      { encoding: 'utf8' },
    );
    expect(parse.stdout).toBe('');
    expect(parse.status).toBe(0);
  });
});

const READ_USER_PATH = "function Read-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }";
const WRITE_USER_PATH = "function Write-UserPath([string]$value) { [Environment]::SetEnvironmentVariable('Path', $value, 'User') }";

describe('install.ps1 PATH contract', () => {
  const source = (): string => fs.readFileSync(SCRIPT, 'utf8');

  it('reads and writes the PATH through one user-scope reader and one user-scope writer', () => {
    const lines = source().split('\n');
    expect(lines.filter((line) => line === READ_USER_PATH)).toHaveLength(1);
    expect(lines.filter((line) => line === WRITE_USER_PATH)).toHaveLength(1);
    expect(source().match(/SetEnvironmentVariable/g)?.length ?? 0).toBe(1);
    expect(source().match(/GetEnvironmentVariable/g)?.length ?? 0).toBe(1);
    expect(source()).not.toMatch(/'Machine'|"Machine"|EnvironmentVariableTarget\]::Machine/);
  });

  it('calls the writer only from a branch that MOMONGA_MODIFY_PATH=0 turns off', () => {
    expect(source()).toContain("$env:MOMONGA_MODIFY_PATH -ne '0'");
    expect(source().match(/\bWrite-UserPath\b/g)?.length ?? 0).toBe(2);
  });

  it('prints the command for the open PowerShell session', () => {
    expect(source()).toContain('`$env:Path = "$prefix;`$env:Path"');
  });
});

const ASSET = 'momonga-win-x64.exe';
const BINARY = Buffer.from('momonga-windows-binary\n');
const NAMESPACE = 'momonga-release';

describe.runIf(pwshAvailable)('install.ps1 PATH behaviour under PowerShell', () => {
  let root = '';
  let server: http.Server;
  let served: Record<string, Buffer> = {};
  let baseUrl = '';
  let publicKey = '';

  beforeAll(async () => {
    root = createTempRoot();
    const privateKey = path.join(root, 'release_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release_key', '-f', privateKey]);
    publicKey = fs.readFileSync(`${privateKey}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    const sums = Buffer.from(`${createHash('sha256').update(BINARY).digest('hex')}  ${ASSET}\n`);
    const sumsFile = path.join(root, 'SHA256SUMS');
    fs.writeFileSync(sumsFile, sums);
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', privateKey, '-n', NAMESPACE, sumsFile]);
    served = { [`/${ASSET}`]: BINARY, '/SHA256SUMS': sums, '/SHA256SUMS.sig': fs.readFileSync(`${sumsFile}.sig`) };
    server = http.createServer((request, response) => {
      const body = served[request.url ?? ''];
      if (body === undefined) return void response.writeHead(404).end();
      response.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    removeTempRoot(root);
  });

  type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

  const stubbedInstaller = (userPathFile: string): string => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    expect(text).toContain(READ_USER_PATH);
    expect(text).toContain(WRITE_USER_PATH);
    const directory = fs.mkdtempSync(path.join(root, 'stubbed-'));
    const script = path.join(directory, 'install.ps1');
    fs.writeFileSync(
      script,
      text
        .replace(READ_USER_PATH, `function Read-UserPath { Get-Content -Raw -LiteralPath '${userPathFile}' }`)
        .replace(WRITE_USER_PATH, `function Write-UserPath([string]$value) { Set-Content -NoNewline -LiteralPath '${userPathFile}' -Value $value }`),
    );
    return script;
  };

  const install = (script: string, prefix: string, extra: NodeJS.ProcessEnv = {}): Promise<Run> =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'],
        HOME: root,
        PROCESSOR_ARCHITECTURE: 'AMD64',
        MOMONGA_INSTALL_PREFIX: prefix,
        MOMONGA_RELEASE_BASE_URL: baseUrl,
        MOMONGA_RELEASE_PUBLIC_KEY: publicKey,
        ...extra,
      };
      execFile('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { env }, (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
        reject(error);
      });
    });

  const setup = (initialUserPath: string): { prefix: string; userPathFile: string; script: string } => {
    const prefix = fs.mkdtempSync(path.join(root, 'prefix-'));
    const userPathFile = path.join(root, `user-path-${path.basename(prefix)}`);
    fs.writeFileSync(userPathFile, initialUserPath);
    return { prefix, userPathFile, script: stubbedInstaller(userPathFile) };
  };

  const openShellLine = (prefix: string): string => `$env:Path = "${prefix};$env:Path"`;

  it('adds the directory to the user PATH once, and prints the command and the changed setting', async () => {
    const { prefix, userPathFile, script } = setup('C:\\Tools;C:\\Other');
    const first = await install(script, prefix);
    expect(first.code).toBe(0);
    expect(fs.readFileSync(userPathFile, 'utf8')).toBe(`C:\\Tools;C:\\Other;${prefix}`);
    const lines = first.stdout.split(/\r?\n/);
    expect(lines.filter((line) => line.trim() === openShellLine(prefix))).toHaveLength(1);
    expect(first.stdout).toContain('user PATH');
    const second = await install(script, prefix);
    expect(second.code).toBe(0);
    expect(fs.readFileSync(userPathFile, 'utf8')).toBe(`C:\\Tools;C:\\Other;${prefix}`);
  });

  it('changes nothing with MOMONGA_MODIFY_PATH=0 and still prints the command', async () => {
    const { prefix, userPathFile, script } = setup('C:\\Tools');
    const run = await install(script, prefix, { MOMONGA_MODIFY_PATH: '0' });
    expect(run.code).toBe(0);
    expect(fs.readFileSync(userPathFile, 'utf8')).toBe('C:\\Tools');
    expect(run.stdout.split(/\r?\n/).filter((line) => line.trim() === openShellLine(prefix))).toHaveLength(1);
  });
});
