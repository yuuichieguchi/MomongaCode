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

export const readOnlyEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(env).filter(([name]) => !CLEARED_GIT_VARIABLES.has(name) && !INHERITED_CONFIG_VARIABLE.test(name))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: String(READ_ONLY_GIT_CONFIG.length),
  ...Object.fromEntries(READ_ONLY_GIT_CONFIG.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
});

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
