import { GIT_APPROVED_SUBCOMMANDS } from '@momonga/policy';
import type { NetworkScope } from '@momonga/foundation';
import type { SandboxNetwork, SandboxPolicy } from '@momonga/sandbox';
import type { ToolContext } from './types.ts';

type ConfigEntry = readonly [key: string, value: string];

const NO_PROGRAM = '/dev/null';
const NO_EDITOR = ':';
const ALTERNATE_REFS_DEFAULT = "f() { git --git-dir=\"$1\" for-each-ref --format='%(objectname)'; }; f";
const PROTOCOLS: readonly string[] = ['ext', 'file', 'ftp', 'ftps', 'git', 'http', 'https', 'ssh'];

const PROGRAM_KEYS: readonly ConfigEntry[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NO_PROGRAM],
  ['core.pager', 'cat'],
  ['core.editor', NO_EDITOR],
  ['core.sshCommand', NO_PROGRAM],
  ['core.askPass', NO_PROGRAM],
  ['core.gitProxy', NO_PROGRAM],
  ['core.alternateRefsCommand', ALTERNATE_REFS_DEFAULT],
  ['gpg.program', NO_PROGRAM],
  ['gpg.ssh.program', NO_PROGRAM],
  ['gpg.x509.program', NO_PROGRAM],
  ['gpg.ssh.defaultKeyCommand', NO_PROGRAM],
  ['credential.helper', ''],
  ['sequence.editor', NO_EDITOR],
  ['interactive.diffFilter', NO_PROGRAM],
  ['uploadpack.packObjectsHook', NO_PROGRAM],
  ['protocol.allow', 'never'],
];

const READ_ONLY_GIT_CONFIG: readonly ConfigEntry[] = [
  ...PROGRAM_KEYS,
  ...PROTOCOLS.map((name): ConfigEntry => [`protocol.${name}.allow`, 'never']),
  ...GIT_APPROVED_SUBCOMMANDS.map((subcommand): ConfigEntry => [`pager.${subcommand}`, 'false']),
];

const CLEARED_GIT_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXTERNAL_DIFF',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PROXY_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_MAN_VIEWER',
  'GIT_ALLOW_PROTOCOL',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
]);

const INHERITED_CONFIG_VARIABLE = /^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/;

const LOCAL_DESTINATION = /^(file:\/\/|\/)/;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const HTTP_PROTOCOLS: readonly string[] = ['http', 'https'];

const protocolOf = (destination: string): string | undefined => (LOCAL_DESTINATION.test(destination) ? 'file' : URL_SCHEME.exec(destination)?.[1]?.toLowerCase());

const TRANSPORT_KEYS: readonly ConfigEntry[] = [
  ['sslVerify', 'true'],
  ['extraHeader', ''],
  ['curloptResolve', ''],
  ['followRedirects', 'initial'],
  ['cookieFile', ''],
  ['saveCookies', 'false'],
];

export const isHttpDestination = (destination: string): boolean => HTTP_PROTOCOLS.includes(protocolOf(destination) ?? '');

const httpDestinationsOf = (destinations: readonly string[]): string[] => destinations.filter(isHttpDestination);

const transportEntries = (keys: readonly ConfigEntry[], destinations: readonly string[]): ConfigEntry[] => [
  ...keys.map(([key, value]): ConfigEntry => [`http.${key}`, value]),
  ...httpDestinationsOf(destinations).flatMap((destination) => keys.map(([key, value]): ConfigEntry => [`http.${destination}.${key}`, value])),
];

const networkConfig = (destinations: readonly string[]): ConfigEntry[] => {
  const needed = new Set(destinations.map(protocolOf));
  return [...PROGRAM_KEYS, ...PROTOCOLS.map((name): ConfigEntry => [`protocol.${name}.allow`, needed.has(name) ? 'always' : 'never']), ...transportEntries(TRANSPORT_KEYS, destinations)];
};

export type GitEnvironmentRequest = { readonly mode: 'read' } | { readonly mode: 'local' } | { readonly mode: 'network'; readonly destinations: readonly string[] };

const QUIET = { GIT_TERMINAL_PROMPT: '0' } as const;
const NO_PAGER = { GIT_PAGER: 'cat', PAGER: 'cat' } as const;
const NO_BACKGROUND_WRITES = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } as const;

const variablesOf = (request: GitEnvironmentRequest): Record<string, string> => (request.mode === 'read' ? { ...NO_BACKGROUND_WRITES, ...QUIET } : { ...QUIET, ...NO_PAGER });

const configOf = (request: GitEnvironmentRequest): readonly ConfigEntry[] => {
  if (request.mode === 'read') return READ_ONLY_GIT_CONFIG;
  return request.mode === 'network' ? networkConfig(request.destinations) : [];
};

export const appendGitConfig = (env: Readonly<Record<string, string>>, entries: readonly ConfigEntry[]): Record<string, string> => {
  const given = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  const start = Number.isInteger(given) && given > 0 ? given : 0;
  if (entries.length === 0) return { ...env };
  return {
    ...env,
    GIT_CONFIG_COUNT: String(start + entries.length),
    ...Object.fromEntries(entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${start + index}`, key], [`GIT_CONFIG_VALUE_${start + index}`, value]])),
  };
};

export const gitEnvironment = (env: Readonly<Record<string, string>>, request: GitEnvironmentRequest): Record<string, string> =>
  appendGitConfig(
    { ...Object.fromEntries(Object.entries(env).filter(([name]) => !CLEARED_GIT_VARIABLES.has(name) && !INHERITED_CONFIG_VARIABLE.test(name))), ...variablesOf(request) },
    configOf(request),
  );

export const gitProxyEnvironment = (env: Readonly<Record<string, string>>, proxy: string, destinations: readonly string[]): Record<string, string> =>
  appendGitConfig(env, transportEntries([['proxy', proxy]], destinations));

export const readOnlyEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> => gitEnvironment(env, { mode: 'read' });

export const readOnlySandboxPolicy = (policy: SandboxPolicy): SandboxPolicy => ({
  ...policy,
  writableRoots: [],
  fileRules: { ...policy.fileRules, entries: policy.fileRules.entries.map((entry) => (entry.widening ? { ...entry, widening: false } : entry)) },
});

export const withNetwork = (policy: SandboxPolicy, network: SandboxNetwork): SandboxPolicy => (policy.network === network ? policy : { ...policy, network });

export const contextWithNetwork = (context: ToolContext, scope: NetworkScope): ToolContext => ({
  ...context,
  network: scope,
  sandboxPolicy: withNetwork(context.sandboxPolicy, scope.kind === 'open' ? 'allow' : 'deny'),
});

export const readOnlyContextOf = (context: ToolContext): ToolContext => {
  const { tmpDir: _sessionTmpDir, ...rest } = context;
  return { ...rest, env: readOnlyEnvironment(context.env), sandboxPolicy: readOnlySandboxPolicy(context.sandboxPolicy) };
};
