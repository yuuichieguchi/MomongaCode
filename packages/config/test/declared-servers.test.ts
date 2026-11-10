import { describe, expect, it } from 'vitest';
import { derivedInputsOf, loadSettings, loadUserSettings, managedServerDigest, settingsInputsDigest } from '@momonga/config';
import type { ResolvedSettings } from '@momonga/config';
import { FM_SERVER } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const COMMAND = '/opt/mine/bin/mine-server';
const ARGS = ['run', '--socket', '{socket}'];
const DECLARATION = { command: COMMAND, args: ARGS, readyPath: '/ready' };

const gatewayInputsDigest = (settings: ResolvedSettings): string => settingsInputsDigest(derivedInputsOf('D1')(settings));

const workbench = (server: string, extra: Record<string, unknown> = {}) => ({ workbench: { adapter: 'managed', server, ...extra } });

const userFile = (tree: Tree, models: Record<string, unknown>): string => writeJson(userSettingsPath(tree), { models });

const declaring = (servers: Record<string, unknown>, targets: Record<string, unknown> = workbench('mine')) => ({ servers, targets, aliases: { default: Object.keys(targets) } });

const loadUser = async (models: Record<string, unknown>) => {
  const tree = makeTree();
  const file = userFile(tree, models);
  return { tree, file, loaded: await loadUserSettings({ home: tree.home }) };
};

const refusalOf = async (models: Record<string, unknown>): Promise<string> => {
  const tree = makeTree();
  userFile(tree, models);
  const outcome = await loadUserSettings({ home: tree.home }).then(
    () => undefined,
    (error: unknown) => (error as Error).message,
  );
  if (outcome === undefined) throw new Error('the settings loaded, but the test expects them to be refused');
  return outcome;
};

const serversOf = (models: unknown): ManagedServerDescription[] => {
  const servers = (models as { servers?: unknown }).servers;
  if (servers === undefined || servers === null) throw new Error('the resolved models carry no servers registry');
  return Object.values(servers as Record<string, ManagedServerDescription>);
};

const declaredOf = (models: unknown, id: string): ManagedServerDescription => {
  const found = serversOf(models).find((server) => server.id === id);
  if (found === undefined) throw new Error(`the resolved registry has no server ${JSON.stringify(id)}`);
  return found;
};

describe('a server declared in the user settings resolves to the one description form (design-managed-servers 19.1, decision 73; R-S19-1)', () => {
  it('parses {command, args, readyPath} and resolves to the description of 19.1, with every fixed field filled', async () => {
    const { loaded } = await loadUser(declaring({ mine: DECLARATION }));
    const description = declaredOf(loaded.settings.models, 'mine');
    expect(description).toEqual({
      id: 'mine',
      provider: 'mine',
      wire: 'chat-completions',
      binary: { defaultPath: COMMAND },
      launch: { argv: ARGS },
      endpoint: FM_SERVER.endpoint,
      ready: { method: 'GET', path: '/ready', status: 200, limitMs: 10_000 },
      preconditions: [],
      identity: ['binarySha256', 'hostOsBuild'],
      restart: { backoffMs: 1000, maxRestarts: 5, windowMs: 60_000 },
      models: { listPath: '/v1/models', idPath: ['data', '0', 'id'] },
      toolForms: ['native', 'envelope'],
      tokenCount: 'estimated',
      errors: [],
      declarable: ['contextWindow', 'maxOutputTokens'],
      recordedDefaults: { stopSequences: false, imageInput: false, tokenCounting: 'estimated', usageReported: false, maxConcurrency: 1 },
      sampling: 'none',
    });
    expect(loaded.settings.models.targets['workbench']).toMatchObject({ adapter: 'managed', server: 'mine', binary: COMMAND, readyTimeoutMs: 10_000 });
  });

  it('refuses an unknown field timeout with the schema text', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, timeout: 5 } }))).toContain('invalid settings at /models/servers/mine/timeout: must NOT have additional properties');
  });
});

describe('a declared id equal to a built-in id is refused (19.1, 19.2; R-S19-2)', () => {
  it('refuses models.servers.fm with the authored text', async () => {
    expect(await refusalOf(declaring({ fm: DECLARATION }, workbench('fm')))).toContain('models.servers.fm: "fm" is a built-in managed server and cannot be declared; choose another id');
  });
});

describe('the declared id follows the provider-name pattern (19.1, 19.2; R-S19-3)', () => {
  it('refuses the id Mine by the pattern', async () => {
    expect(await refusalOf(declaring({ Mine: DECLARATION }, workbench('Mine')))).toContain('invalid settings at /models/servers: must match pattern "^[a-z][a-z0-9._-]*$"');
  });

  it('accepts the id mine', async () => {
    const { loaded } = await loadUser(declaring({ mine: DECLARATION }));
    expect(declaredOf(loaded.settings.models, 'mine').id).toBe('mine');
  });
});

describe('the declared command is an absolute, non-empty path (19.2; R-S19-4)', () => {
  it('refuses a relative command with the authored text', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, command: 'bin/mine-server' } }))).toContain('models.servers.mine.command must be an absolute path; got "bin/mine-server"');
  });

  it('refuses an empty command with the schema text', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, command: '' } }))).toContain('invalid settings at /models/servers/mine/command: must NOT have fewer than 1 characters');
  });

  it('refuses a declaration with no command with the schema text', async () => {
    const { command: _command, ...withoutCommand } = DECLARATION;
    expect(await refusalOf(declaring({ mine: withoutCommand }))).toContain("invalid settings at /models/servers/mine: must have required property 'command'");
  });
});

describe('args hold the {socket} placeholder exactly once, as a whole argument (19.1, 19.2; R-S19-5)', () => {
  it('refuses args with no placeholder: found 0', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, args: ['run'] } }))).toContain('models.servers.mine.args must contain "{socket}" exactly once; found 0');
  });

  it('refuses args with two placeholders: found 2', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, args: ['{socket}', '--again', '{socket}'] } }))).toContain('models.servers.mine.args must contain "{socket}" exactly once; found 2');
  });

  it('refuses the placeholder inside a longer argument, naming its index', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, args: ['run', '--socket={socket}'] } }))).toContain(
      'models.servers.mine.args[1] contains "{socket}" inside a longer argument; the placeholder must be a whole argument',
    );
  });
});

describe('readyPath starts with a slash (19.2; R-S19-6)', () => {
  it('refuses a readyPath without a leading slash with the schema text', async () => {
    expect(await refusalOf(declaring({ mine: { ...DECLARATION, readyPath: 'ready' } }))).toContain('invalid settings at /models/servers/mine/readyPath: must match pattern "^/"');
  });
});

describe('an unknown server lists the built-in and the declared ids, sorted (19.2; R-S19-7)', () => {
  it('refuses server "mine" when only "kiln" is declared, listing fm and kiln', async () => {
    expect(await refusalOf(declaring({ kiln: DECLARATION }, workbench('mine')))).toContain(
      'models.targets.workbench: server "mine" is not a managed server this build supports; supported: fm, kiln',
    );
  });
});

describe('a declaration outside the user settings is discarded with a warning (19.2; R-S19-8)', () => {
  const projectModels = { servers: { mine: DECLARATION }, targets: workbench('mine'), aliases: { default: ['workbench'] } };

  it.each([
    ['the project settings file', projectSettingsPath],
    ['the local settings file', localSettingsPath],
  ])('discards models.servers in %s and the target that names it', async (_label, fileOf) => {
    const tree = makeTree();
    userFile(tree, { targets: { remote: { adapter: 'chat-completions', model: 'm', provider: 'example', baseUrl: 'https://example.invalid/v1', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } } } });
    const file = writeJson(fileOf(tree), { models: projectModels });
    const loaded = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(loaded.warnings).toContain(`${file}: models.servers is only honored in user settings; discarded`);
    expect(Object.keys(loaded.settings.models.targets)).toEqual(['remote']);
  });
});

describe('a change of a declared server re-derives the gateway through its pinned inputs (design-settings-live 3.1 and its note on 19.5; R-S19-11)', () => {
  it('gives different gateway inputs when only args change', async () => {
    const before = (await loadUser(declaring({ mine: DECLARATION }))).loaded.settings;
    const after = (await loadUser(declaring({ mine: { ...DECLARATION, args: ['run', '--verbose', '--socket', '{socket}'] } }))).loaded.settings;
    expect(gatewayInputsDigest(after)).not.toBe(gatewayInputsDigest(before));
  });

  it('gives the same gateway inputs for the same declaration', async () => {
    const first = (await loadUser(declaring({ mine: DECLARATION }))).loaded.settings;
    const second = (await loadUser(declaring({ mine: DECLARATION }))).loaded.settings;
    expect(gatewayInputsDigest(second)).toBe(gatewayInputsDigest(first));
  });
});

describe('the behaviour stamp of a description ignores what does not change the probe behaviour (19.4, 19.14 item 2; R-S19-12)', () => {
  it('keeps the stamp when only provider changes', () => {
    expect(managedServerDigest({ ...FM_SERVER, provider: 'someone-else' })).toBe(managedServerDigest(FM_SERVER));
  });

  it('keeps the stamp when only an errors[].message changes', () => {
    const errors = FM_SERVER.errors.map((entry, index) => (index === 0 ? { ...entry, message: 'A reworded guardrail message.' } : entry));
    expect(managedServerDigest({ ...FM_SERVER, errors })).toBe(managedServerDigest(FM_SERVER));
  });

  it('changes the stamp when the launch argv changes', () => {
    expect(managedServerDigest({ ...FM_SERVER, launch: { argv: ['serve', '--verbose', '--socket', '{socket}'] } })).not.toBe(managedServerDigest(FM_SERVER));
  });
});
