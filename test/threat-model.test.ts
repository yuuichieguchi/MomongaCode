import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSandboxSetting } from '@momonga/config';
import { CREDENTIAL_CAPABILITY_ENV, CREDENTIAL_CAPABILITY_HEADER, CREDENTIAL_PATHS, DEFAULT_SANDBOX_NETWORK, ENDPOINT_TOKEN_FILE, SECRET_PROGRAM_ENV } from '@momonga/foundation';
import { ATTACHED_FILE_TAG, PERSON_CAPABILITY_HEADER, TOOL_OUTPUT_TAG, USER_SHELL_TAG } from '@momonga/protocol';
import { PERSON_CAPABILITY_FILE } from '../packages/foundation/src/platform/person-capability.ts';
import { OWNER_ONLY_SECRET_BYTES } from '../packages/foundation/src/platform/owner-only-secret.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const doc = read('site/docs/threat-model.md');

const sectionOf = (heading: string): string => {
  const lines = doc.split('\n');
  const start = lines.indexOf(heading);
  expect(start, `docs/threat-model.md has the section ${heading}`).toBeGreaterThan(-1);
  const length = lines.slice(start + 1).findIndex((line) => /^## /.test(line));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join('\n');
};

const PLATFORM_WORDS = [
  ['darwin', 'macOS'],
  ['linux', 'Linux'],
  ['win32', 'Windows'],
] as const;

const serviceRoutes = (): Set<string> => {
  const folder = 'packages/runtime/src/service';
  const found = new Set<string>();
  for (const name of fs.readdirSync(path.join(root, folder))) {
    if (!name.endsWith('.ts')) continue;
    const text = read(`${folder}/${name}`);
    const declarations = text.split(/(?=\broute\(')/).slice(1);
    for (const declaration of declarations) {
      const routePath = /^route\('([^']+)'/.exec(declaration)?.[1];
      const access = /\{ person: \[([^\]]*)\] \}\);/.exec(declaration)?.[1] ?? '';
      for (const [, method] of access.matchAll(/'([A-Z]+)'/g)) found.add(`${method} ${routePath}`);
    }
  }
  return found;
};

const capabilityBytesOfSupervisor = (): number => {
  const match = /const CAPABILITY_BYTES = (\d+);/.exec(read('packages/supervisor/src/child-manager.ts'));
  expect(match).not.toBeNull();
  return Number(match?.[1]);
};

describe('docs/threat-model.md states only what the product does', () => {
  it('no longer claims that the sandbox denies every network access', () => {
    expect(doc).not.toContain('Network access is denied inside the sandbox');
  });

  it('quotes the default of sandboxNetwork that the settings use', () => {
    const quoted = /The default of `sandboxNetwork` is `(\w+)`/.exec(doc);
    expect(quoted?.[1]).toBe(DEFAULT_SANDBOX_NETWORK);
  });

  it.for(PLATFORM_WORDS)('quotes the default of sandbox on %s', ([platform, word]) => {
    const quoted = new RegExp(`The default of \`sandbox\` is[^.]*\`(\\w+)\` on ${word}`).exec(doc) ?? new RegExp(`\`(\\w+)\` on ${word}`).exec(sectionOf('## Settings this document quotes'));
    expect(quoted?.[1]).toBe(defaultSandboxSetting(platform));
  });

  it('says that a missing launcher on macOS or Linux refuses a sandboxed run, never falls to none', () => {
    expect(doc).toContain('when it is not, a sandboxed run refuses to start and names the launchers it looked for, and the default never falls to `none`');
  });

  it('lists every secret location by the name the product denies', () => {
    const section = sectionOf('## Secret locations');
    const listed = [...section.matchAll(/`~\/([^`]+)`/g)].map((match) => match[1]);
    expect(listed).toEqual([...CREDENTIAL_PATHS]);
  });

  it('names exactly the routes that act for the person', () => {
    const section = sectionOf("## The person's capability");
    const listed = new Set([...section.matchAll(/`([A-Z]+ \/v1\/[^`]+)`/g)].map((match) => match[1]));
    expect(listed).toEqual(serviceRoutes());
    expect(section).toContain(`\`${PERSON_CAPABILITY_HEADER}\``);
    expect(section).toContain(`\`${PERSON_CAPABILITY_FILE}\``);
    expect(section).toContain(`${OWNER_ONLY_SECRET_BYTES * 8}-bit`);
  });

  it('describes the credential route of the supervisor with its capability', () => {
    const section = sectionOf('## The credential route of the supervisor');
    expect(read('packages/supervisor/src/control-server.ts')).toContain("const CREDENTIALS_PATH = '/v1/credentials/';");
    expect(read('packages/gateway/src/process.ts')).toContain("method: 'GET', path: `/v1/credentials/${encodeURIComponent(name)}`");
    expect(section).toContain('`GET /v1/credentials/<NAME>`');
    expect(section).toContain(`\`${CREDENTIAL_CAPABILITY_ENV}\``);
    expect(section).toContain(`\`${CREDENTIAL_CAPABILITY_HEADER}\``);
    expect(section).toContain(`${capabilityBytesOfSupervisor() * 8}-bit`);
  });

  it('states that the secret-store program is trusted through PATH and names how it is shown', () => {
    const section = sectionOf('## The secret-store program is found on PATH');
    expect(section).toContain(`\`${SECRET_PROGRAM_ENV}\``);
    expect(read('packages/supervisor/src/log-events.ts')).toContain("'secret_store.chosen'");
    expect(section).toContain('`secret_store.chosen`');
    expect(section).not.toContain('momonga secret status');
  });

  it('states the random part of the Windows pipe names and its file', () => {
    const section = sectionOf('## Windows pipe names');
    expect(section).toContain(`\`run/${ENDPOINT_TOKEN_FILE}\``);
    expect(section).toContain(`${OWNER_ONLY_SECRET_BYTES * 8}-bit`);
    expect(read('packages/foundation/src/socket-path.ts')).toContain('const PRODUCT_PIPE_PREFIX = `${PIPE_PREFIX}momonga-`;');
  });

  it('names the one fence and each kind of untrusted text it encloses', () => {
    const section = sectionOf('## Untrusted text reaches the model');
    expect(section).toContain('`fenceUntrusted`');
    for (const tag of [TOOL_OUTPUT_TAG, ATTACHED_FILE_TAG, USER_SHELL_TAG]) expect(section).toContain(`\`${tag}\``);
  });

  it('names only environment variables the product defines', () => {
    const foundation = read('packages/foundation/src/process-contract.ts') + read('packages/foundation/src/secret-store.ts');
    for (const [, name] of doc.matchAll(/`(MOMONGA_[A-Z_]+)`/g)) expect(foundation).toContain(`'${name}'`);
  });

  it('names only settings the product reads', () => {
    const settings = read('packages/config/src/settings.ts');
    for (const name of ['sandboxUnixSockets', 'sandboxNetwork', 'idempotencyKeyHeader']) {
      expect(doc).toContain(`\`${name}`);
      expect(settings).toContain(name);
    }
  });
});
