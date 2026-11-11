import type { CredentialSecretStore } from './encrypted-credential-store.ts';
import { nodeFileSystem, nodeFileSystemSync } from './node-file-system.ts';
import { settledOrAborted } from './operation-limit.ts';
import { findProgramOnPathSync, programOwnerProblemSync } from './program-search.ts';
import { declaredChildEnv } from './process-contract.ts';
import { powershellArgs, powershellPath } from './platform/windows-scripts.ts';
import { SecretStoreAbsentError, SecretStoreAnswerError, endedStoreCall } from './secret-store-failures.ts';
import type { NamedSecretCall } from './secret-store-failures.ts';

export const SECRET_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export const KEYCHAIN_SERVICE = 'momonga';
export const SECURITY_BINARY = '/usr/bin/security';

export type SecretProcessResult = { exitCode: number; stdout: string; stderr: string };

export type SecretProcessPort = (file: string, args: readonly string[], stdin: string, signal: AbortSignal) => Promise<SecretProcessResult>;

export type FileKind = 'file' | 'other' | 'missing';

export type SecretStoreFiles = { stat(path: string): Promise<{ isFile(): boolean }> };

export const nodeSecretStoreFiles: SecretStoreFiles = { stat: (path) => nodeFileSystem.stat(path) };

export type ReadinessReading =
  | { kind: 'absent'; reason: string }
  | { kind: 'unknown'; excerpt: string }
  | { kind: 'file'; path: string; named: string };

export type Readiness = {
  advice: string;
  args: readonly string[];
  read(result: SecretProcessResult): ReadinessReading;
};

export type SecretBackend = {
  label: string;
  searchedProgram: string;
  childEnvNames: readonly string[];
  storeCommand(secretName: string): string;
  unansweredAdvice: string | undefined;
  readiness: Readiness | undefined;
  notFound(result: SecretProcessResult): boolean;
};

export type SecretStore = {
  readonly backend?: SecretBackend;
  read(name: string, signal: AbortSignal): Promise<string>;
  write(name: string, value: string, signal: AbortSignal): Promise<void>;
};

const KEYCHAIN_ITEM_NOT_FOUND_EXIT = 44;
const SECRET_TOOL_NOT_FOUND_EXIT = 1;
const CREDENTIAL_NOT_FOUND_EXIT = 3;

const DEFAULT_KEYCHAIN_ANSWER = /^    "(.+)"\n$/;
const DEFAULT_KEYCHAIN_REFUSAL = /^(?:[^:\n]*: )?(SecKeychainCopyDefault: .*)$/;
const READINESS_EXCERPT_CHARACTERS = 200;

const firstLineOf = (text: string): string => text.split('\n', 1)[0] as string;

const readinessExcerptOf = (result: SecretProcessResult): string => {
  const stderr = result.stderr.trim();
  const said = stderr === '' ? result.stdout.trim() : stderr;
  return said === '' ? 'no output' : said.slice(0, READINESS_EXCERPT_CHARACTERS);
};

const readDefaultKeychain = (result: SecretProcessResult): ReadinessReading => {
  const answered = result.exitCode === 0 ? DEFAULT_KEYCHAIN_ANSWER.exec(result.stdout) : null;
  if (answered !== null) {
    const path = answered[1] as string;
    return { kind: 'file', path, named: `the default keychain ${path}` };
  }
  const refused = result.exitCode === 0 ? null : DEFAULT_KEYCHAIN_REFUSAL.exec(firstLineOf(result.stderr));
  if (refused !== null) return { kind: 'absent', reason: `security reports no default keychain (${refused[1] as string})` };
  return { kind: 'unknown', excerpt: readinessExcerptOf(result) };
};

export const KEYCHAIN_BACKEND: SecretBackend = {
  label: 'Keychain',
  searchedProgram: 'security',
  childEnvNames: [],
  storeCommand: (secretName) => `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${secretName} -w`,
  unansweredAdvice: 'the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain',
  readiness: { advice: 'make a default keychain available', args: ['default-keychain'], read: readDefaultKeychain },
  notFound: (result) => result.exitCode === KEYCHAIN_ITEM_NOT_FOUND_EXIT,
};

export const SECRET_SERVICE_BACKEND: SecretBackend = {
  label: 'Secret Service',
  searchedProgram: 'secret-tool',
  childEnvNames: ['DBUS_SESSION_BUS_ADDRESS'],
  storeCommand: (secretName) => `secret-tool store --label=${KEYCHAIN_SERVICE} service ${KEYCHAIN_SERVICE} account ${secretName}`,
  unansweredAdvice: 'the Secret Service may be waiting for you to answer a prompt: answer it or unlock the keyring',
  readiness: undefined,
  notFound: (result) => result.exitCode === SECRET_TOOL_NOT_FOUND_EXIT && result.stdout === '' && result.stderr.trim() === '',
};

export const CREDENTIAL_MANAGER_BACKEND: SecretBackend = {
  label: 'Credential Manager',
  searchedProgram: 'cmdkey',
  childEnvNames: ['SystemRoot'],
  storeCommand: (secretName) => `cmdkey /generic:${KEYCHAIN_SERVICE}/${secretName} /user:${KEYCHAIN_SERVICE} /pass`,
  unansweredAdvice: undefined,
  readiness: undefined,
  notFound: (result) => result.exitCode === CREDENTIAL_NOT_FOUND_EXIT,
};

const answeredAs = (exitCode: number, detail: string): string => `exit ${exitCode}${detail === '' ? '' : `: ${detail}`}`;

export class SecretUnavailableError extends Error {
  readonly secretName: string;
  readonly exitCode: number;
  readonly detail: string;
  readonly backend: SecretBackend;

  constructor(secretName: string, exitCode: number, detail: string, backend: SecretBackend = KEYCHAIN_BACKEND) {
    super(
      `the secret "${secretName}" could not be read from the ${backend.label} (${answeredAs(exitCode, detail)}); store it with: ${backend.storeCommand(secretName)}; the gateway reads a missing secret again on the next request`,
    );
    this.name = 'SecretUnavailableError';
    this.secretName = secretName;
    this.exitCode = exitCode;
    this.detail = detail;
    this.backend = backend;
  }

  get answer(): string {
    return answeredAs(this.exitCode, this.detail);
  }
}

export class SecretNotFoundError extends SecretUnavailableError {
  constructor(secretName: string, exitCode: number, detail: string, backend: SecretBackend = KEYCHAIN_BACKEND) {
    super(secretName, exitCode, detail, backend);
    this.name = 'SecretNotFoundError';
  }
}

export class SecretWriteError extends Error {
  readonly secretName: string;
  readonly exitCode: number;

  constructor(secretName: string, exitCode: number, detail: string, backend: SecretBackend = KEYCHAIN_BACKEND) {
    super(`the secret "${secretName}" could not be written to the ${backend.label} (exit ${exitCode}${detail === '' ? '' : `: ${detail}`})`);
    this.name = 'SecretWriteError';
    this.secretName = secretName;
    this.exitCode = exitCode;
  }
}

export class SecretEmptyError extends Error {
  readonly secretName: string;

  constructor(secretName: string, backend: SecretBackend = KEYCHAIN_BACKEND) {
    super(`the secret "${secretName}" is empty in the ${backend.label}`);
    this.name = 'SecretEmptyError';
    this.secretName = secretName;
  }
}

const NAME_SHAPE = new RegExp(SECRET_NAME_PATTERN);

const withoutOneTrailingNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

export const SECRET_TOOL_BINARY = '/usr/bin/secret-tool';

type SecretCommand = { args: readonly string[]; stdin?: string };

type CommandStoreHost = { run: SecretProcessPort; program: string; backend: SecretBackend; files: SecretStoreFiles };

const assertNameShape = (name: string): void => {
  if (!NAME_SHAPE.test(name)) throw new RangeError(`secret name ${JSON.stringify(name)} does not match ${SECRET_NAME_PATTERN}`);
};

type CheckedFile = { kind: FileKind } | { kind: 'unchecked'; detail: string };

const NO_SUCH_FILE_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

const errorCodeOf = (error: unknown): string | undefined => {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code : undefined;
};

const checkedFile = async (files: SecretStoreFiles, path: string, signal: AbortSignal): Promise<CheckedFile> => {
  let stat: { isFile(): boolean };
  try {
    stat = await settledOrAborted(files.stat(path), signal);
  } catch (error) {
    if (signal.aborted && error === signal.reason) throw error;
    const code = errorCodeOf(error);
    if (code !== undefined && NO_SUCH_FILE_CODES.includes(code)) return { kind: 'missing' };
    return { kind: 'unchecked', detail: code ?? (error instanceof Error ? error.message : String(error)) };
  }
  return { kind: stat.isFile() ? 'file' : 'other' };
};

const createCommandSecretStore = (
  { run, program, backend, files }: CommandStoreHost,
  commands: { read(name: string): SecretCommand; write(name: string, value: string): SecretCommand },
): SecretStore => {
  const assertReady = async (call: NamedSecretCall, signal: AbortSignal): Promise<void> => {
    const { readiness } = backend;
    if (readiness === undefined) return;
    const answer = await run(program, readiness.args, '', signal);
    const reading = readiness.read(answer);
    if (reading.kind === 'absent') throw new SecretStoreAbsentError({ reason: reading.reason, backend, call });
    if (reading.kind === 'unknown') throw new SecretStoreAnswerError(backend, answer.exitCode, reading.excerpt);
    const checked = await checkedFile(files, reading.path, signal);
    if (checked.kind === 'missing') throw new SecretStoreAbsentError({ reason: `${reading.named} does not exist`, backend, call });
    if (checked.kind === 'other') throw new SecretStoreAnswerError(backend, answer.exitCode, `${reading.named} is not a file`);
    if (checked.kind === 'unchecked') throw new SecretStoreAnswerError(backend, answer.exitCode, `${reading.named} could not be checked: ${checked.detail}`);
  };

  const answeredWhenReady = async (call: NamedSecretCall, command: SecretCommand, signal: AbortSignal): Promise<SecretProcessResult> => {
    try {
      signal.throwIfAborted();
      await assertReady(call, signal);
      return await run(program, command.args, command.stdin ?? '', signal);
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw endedStoreCall({ ...call, backend }, error);
      throw error;
    }
  };

  return {
    backend,
    read: async (name, signal) => {
      assertNameShape(name);
      const result = await answeredWhenReady({ action: 'read', name }, commands.read(name), signal);
      if (result.exitCode !== 0) {
        const Refusal = backend.notFound(result) ? SecretNotFoundError : SecretUnavailableError;
        throw new Refusal(name, result.exitCode, result.stderr.trim(), backend);
      }
      const value = withoutOneTrailingNewline(result.stdout);
      if (value === '') throw new SecretEmptyError(name, backend);
      return value;
    },
    write: async (name, value, signal) => {
      assertNameShape(name);
      if (value === '') throw new RangeError('a secret value must not be empty');
      const result = await answeredWhenReady({ action: 'write', name }, commands.write(name, value), signal);
      if (result.exitCode !== 0) throw new SecretWriteError(name, result.exitCode, result.stderr.trim(), backend);
    },
  };
};

export const keychainWriteCommand = (name: string, value: string): string =>
  `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -X ${Buffer.from(value, 'utf8').toString('hex')}\n`;

export const createKeychainSecretStore = (run: SecretProcessPort, security: string, files: SecretStoreFiles = nodeSecretStoreFiles): SecretStore =>
  createCommandSecretStore(
    { run, program: security, backend: KEYCHAIN_BACKEND, files },
    {
      read: (name) => ({ args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'] }),
      write: (name, value) => ({ args: ['-i'], stdin: keychainWriteCommand(name, value) }),
    },
  );

export const createSecretServiceStore = (run: SecretProcessPort, secretTool: string, files: SecretStoreFiles = nodeSecretStoreFiles): SecretStore =>
  createCommandSecretStore(
    { run, program: secretTool, backend: SECRET_SERVICE_BACKEND, files },
    {
      read: (name) => ({ args: ['lookup', 'service', KEYCHAIN_SERVICE, 'account', name] }),
      write: (name, value) => ({ args: ['store', `--label=${KEYCHAIN_SERVICE}`, 'service', KEYCHAIN_SERVICE, 'account', name], stdin: value }),
    },
  );

export const credentialReadScript = (target: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class MomongaCredential {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct CREDENTIAL {',
    '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
    '    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;',
    '    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
    '  }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);',
    '  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);',
    '  const uint CRED_TYPE_GENERIC = 1;',
    '  const int ERROR_NOT_FOUND = 1168;',
    '  public static int Read(string target, out string secret) {',
    '    IntPtr pointer;',
    '    secret = null;',
    '    if (!CredReadW(target, CRED_TYPE_GENERIC, 0, out pointer)) return Marshal.GetLastWin32Error();',
    '    try {',
    '      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));',
    '      secret = Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);',
    '      return 0;',
    '    } finally { CredFree(pointer); }',
    '  }',
    '}',
    "'@",
    '$secret = $null',
    `$status = [MomongaCredential]::Read('${target}', [ref]$secret)`,
    `if ($status -eq 1168) { exit ${CREDENTIAL_NOT_FOUND_EXIT} }`,
    'if ($status -ne 0) { [Console]::Error.WriteLine("CredRead failed with Win32 error $status"); exit 2 }',
    '[Console]::Out.Write($secret)',
  ].join('\n');

export const credentialWriteScript = (target: string, userName: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class MomongaCredentialWriter {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct CREDENTIAL {',
    '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
    '    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;',
    '    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
    '  }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);',
    '  const uint CRED_TYPE_GENERIC = 1;',
    '  const uint CRED_PERSIST_LOCAL_MACHINE = 2;',
    '  public static int Write(string target, string userName, string secret) {',
    '    byte[] blob = System.Text.Encoding.Unicode.GetBytes(secret);',
    '    IntPtr pointer = Marshal.AllocHGlobal(blob.Length);',
    '    try {',
    '      Marshal.Copy(blob, 0, pointer, blob.Length);',
    '      CREDENTIAL credential = new CREDENTIAL();',
    '      credential.Type = CRED_TYPE_GENERIC; credential.TargetName = target; credential.UserName = userName;',
    '      credential.CredentialBlobSize = (uint)blob.Length; credential.CredentialBlob = pointer; credential.Persist = CRED_PERSIST_LOCAL_MACHINE;',
    '      return CredWriteW(ref credential, 0) ? 0 : Marshal.GetLastWin32Error();',
    '    } finally { Marshal.FreeHGlobal(pointer); }',
    '  }',
    '}',
    "'@",
    '$secret = [Console]::In.ReadToEnd()',
    `$status = [MomongaCredentialWriter]::Write('${target}', '${userName}', $secret)`,
    'if ($status -ne 0) { [Console]::Error.WriteLine("CredWrite failed with Win32 error $status"); exit 2 }',
  ].join('\n');

export const createCredentialManagerStore = (
  run: SecretProcessPort,
  powershell: { file: string; args(script: string): readonly string[] },
  files: SecretStoreFiles = nodeSecretStoreFiles,
): SecretStore =>
  createCommandSecretStore(
    { run, program: powershell.file, backend: CREDENTIAL_MANAGER_BACKEND, files },
    {
      read: (name) => ({ args: powershell.args(credentialReadScript(`${KEYCHAIN_SERVICE}/${name}`)) }),
      write: (name, value) => ({ args: powershell.args(credentialWriteScript(`${KEYCHAIN_SERVICE}/${name}`, KEYCHAIN_SERVICE)), stdin: value }),
    },
  );

type SecretEnv = Readonly<Record<string, string | undefined>>;

export const SECRET_BACKEND_ENV = 'MOMONGA_SECRET_BACKEND';
export const SECRET_PROGRAM_ENV = 'MOMONGA_SECRET_PROGRAM';
export const SECRET_REFUSAL_ENV = 'MOMONGA_SECRET_REFUSAL';

type SecretBackendKind = { backend: SecretBackend; create(run: SecretProcessPort, program: string, files: SecretStoreFiles): SecretStore };

const SECRET_BACKENDS: Readonly<Record<BackendId, SecretBackendKind>> = {
  keychain: { backend: KEYCHAIN_BACKEND, create: (run, program, files) => createKeychainSecretStore(run, program, files) },
  'secret-service': { backend: SECRET_SERVICE_BACKEND, create: (run, program, files) => createSecretServiceStore(run, program, files) },
  'credential-manager': { backend: CREDENTIAL_MANAGER_BACKEND, create: (run, program, files) => createCredentialManagerStore(run, { file: program, args: powershellArgs }, files) },
};

export const SECRET_STORE_SEARCHED_PROGRAMS: readonly string[] = Object.values(SECRET_BACKENDS).map((kind) => kind.backend.searchedProgram);

type ChosenSecretStore = { kind: 'chosen'; id: string; program: string } | { kind: 'none'; reason: string };

const searchedAs = (backend: SecretBackend): string => `${backend.searchedProgram} (${backend.label})`;

const notOnPath = (backend: SecretBackend): string => `${searchedAs(backend)} is not on PATH`;

export type SecretHost = { readonly platform: NodeJS.Platform; readonly uid: number | undefined };

type BackendId = 'keychain' | 'secret-service' | 'credential-manager';

const PLATFORM_BACKENDS: Readonly<Partial<Record<NodeJS.Platform, BackendId>>> = {
  darwin: 'keychain',
  linux: 'secret-service',
  freebsd: 'secret-service',
  openbsd: 'secret-service',
  netbsd: 'secret-service',
  win32: 'credential-manager',
};

const trusted = (program: string, host: SecretHost): ChosenSecretStore | undefined => {
  if (host.uid === undefined) return undefined;
  const problem = programOwnerProblemSync(program, nodeFileSystemSync, host.uid);
  return problem === undefined ? undefined : { kind: 'none', reason: problem };
};

const chosenProgram = (id: BackendId, program: string, host: SecretHost): ChosenSecretStore => trusted(program, host) ?? { kind: 'chosen', id, program };

const chooseSecretBackend = (env: SecretEnv, host: SecretHost): ChosenSecretStore => {
  const id = PLATFORM_BACKENDS[host.platform];
  if (id === undefined) return { kind: 'none', reason: `MomongaCode knows no secret store of the platform ${host.platform}` };
  if (id === 'credential-manager') return chosenProgram(id, powershellPath(env), host);
  const backend = SECRET_BACKENDS[id].backend;
  const program = findProgramOnPathSync(backend.searchedProgram, env, nodeFileSystemSync);
  if (program === undefined) return { kind: 'none', reason: notOnPath(backend) };
  if (id === 'secret-service') {
    const busAddress = env['DBUS_SESSION_BUS_ADDRESS'];
    if (busAddress === undefined || busAddress === '') {
      return { kind: 'none', reason: `${searchedAs(backend)} is on PATH at ${program}, but no D-Bus session is set (DBUS_SESSION_BUS_ADDRESS is empty)` };
    }
  }
  return chosenProgram(id, program, host);
};

const backendKindOf = (id: string): SecretBackendKind | undefined => (Object.hasOwn(SECRET_BACKENDS, id) ? SECRET_BACKENDS[id as BackendId] : undefined);

export const secretStoreEnvFor = (hostEnv: SecretEnv, host: SecretHost): Record<string, string> => {
  const chosen = chooseSecretBackend(hostEnv, host);
  if (chosen.kind === 'none') return { [SECRET_REFUSAL_ENV]: chosen.reason };
  const kind = backendKindOf(chosen.id) as SecretBackendKind;
  return { [SECRET_BACKEND_ENV]: chosen.id, [SECRET_PROGRAM_ENV]: chosen.program, ...declaredChildEnv(hostEnv, kind.backend.childEnvNames) };
};

type GivenSecretStore = { kind: 'given'; backend: SecretBackendKind; program: string } | { kind: 'none'; reason: string };

const givenSecretStore = (givenEnv: SecretEnv): GivenSecretStore => {
  const id = givenEnv[SECRET_BACKEND_ENV];
  const program = givenEnv[SECRET_PROGRAM_ENV];
  if (id === undefined || program === undefined || program === '') {
    return { kind: 'none', reason: givenEnv[SECRET_REFUSAL_ENV] ?? `no secret store was given to this process (${SECRET_BACKEND_ENV} and ${SECRET_PROGRAM_ENV} are not set)` };
  }
  const backend = backendKindOf(id);
  if (backend === undefined) return { kind: 'none', reason: `${SECRET_BACKEND_ENV} names an unknown secret store: ${id}` };
  return { kind: 'given', backend, program };
};

export const givenSecretStoreChildEnv = (givenEnv: SecretEnv): Record<string, string> => {
  const given = givenSecretStore(givenEnv);
  return given.kind === 'none' ? {} : declaredChildEnv(givenEnv, given.backend.backend.childEnvNames);
};

export const givenCredentialSecretStore = (run: SecretProcessPort, givenEnv: SecretEnv, files: SecretStoreFiles = nodeSecretStoreFiles): CredentialSecretStore => {
  const given = givenSecretStore(givenEnv);
  return given.kind === 'none' ? given : { kind: 'available', store: given.backend.create(run, given.program, files) };
};

export const createGivenSecretStore = (run: SecretProcessPort, givenEnv: SecretEnv, files: SecretStoreFiles = nodeSecretStoreFiles): SecretStore => {
  const storeFor = (call: NamedSecretCall): SecretStore => {
    const given = givenCredentialSecretStore(run, givenEnv, files);
    if (given.kind === 'none') throw new SecretStoreAbsentError({ reason: given.reason, call });
    return given.store;
  };
  const given = givenSecretStore(givenEnv);
  return {
    ...(given.kind === 'none' ? {} : { backend: given.backend.backend }),
    read: async (name, signal) => storeFor({ action: 'read', name }).read(name, signal),
    write: async (name, value, signal) => storeFor({ action: 'write', name }).write(name, value, signal),
  };
};

const chosenStoreFor = (run: SecretProcessPort, env: SecretEnv, host: SecretHost, files: SecretStoreFiles, call: NamedSecretCall): SecretStore => {
  const chosen = chooseSecretBackend(env, host);
  if (chosen.kind === 'none') throw new SecretStoreAbsentError({ reason: chosen.reason, call });
  return (backendKindOf(chosen.id) as SecretBackendKind).create(run, chosen.program, files);
};

export const createPlatformSecretStore = (run: SecretProcessPort, env: SecretEnv, host: SecretHost, files: SecretStoreFiles = nodeSecretStoreFiles): SecretStore => ({
  read: async (name, signal) => chosenStoreFor(run, env, host, files, { action: 'read', name }).read(name, signal),
  write: async (name, value, signal) => chosenStoreFor(run, env, host, files, { action: 'write', name }).write(name, value, signal),
});
