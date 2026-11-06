import { findProgramOnPath } from './program-search.ts';
import { powershellArgs, powershellPath } from './platform/windows-scripts.ts';

export const SECRET_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export const KEYCHAIN_SERVICE = 'momonga';
export const SECURITY_BINARY = '/usr/bin/security';

export type SecretStore = {
  read(name: string, signal: AbortSignal): Promise<string>;
  write(name: string, value: string, signal: AbortSignal): Promise<void>;
};

export type SecretProcessResult = { exitCode: number; stdout: string; stderr: string };

export type SecretProcessPort = (file: string, args: readonly string[], stdin: string, signal: AbortSignal) => Promise<SecretProcessResult>;

export type SecretBackend = { label: string; childEnvNames: readonly string[]; storeCommand(secretName: string): string };

export const KEYCHAIN_BACKEND: SecretBackend = {
  label: 'Keychain',
  childEnvNames: [],
  storeCommand: (secretName) => `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${secretName} -w`,
};

export const SECRET_SERVICE_BACKEND: SecretBackend = {
  label: 'Secret Service',
  childEnvNames: ['DBUS_SESSION_BUS_ADDRESS'],
  storeCommand: (secretName) => `secret-tool store --label=${KEYCHAIN_SERVICE} service ${KEYCHAIN_SERVICE} account ${secretName}`,
};

export const CREDENTIAL_MANAGER_BACKEND: SecretBackend = {
  label: 'Credential Manager',
  childEnvNames: ['SystemRoot'],
  storeCommand: (secretName) => `cmdkey /generic:${KEYCHAIN_SERVICE}/${secretName} /user:${KEYCHAIN_SERVICE} /pass`,
};

export class SecretUnavailableError extends Error {
  readonly secretName: string;
  readonly exitCode: number;

  constructor(secretName: string, exitCode: number, detail: string, backend: SecretBackend = KEYCHAIN_BACKEND) {
    super(
      `the secret "${secretName}" could not be read from the ${backend.label} (exit ${exitCode}${detail === '' ? '' : `: ${detail}`}); store it with: ${backend.storeCommand(secretName)}; the gateway reads a missing secret again on the next request`,
    );
    this.name = 'SecretUnavailableError';
    this.secretName = secretName;
    this.exitCode = exitCode;
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

type SecretCommand = { file: string; args: readonly string[]; backend: SecretBackend; stdin?: string };

const assertNameShape = (name: string): void => {
  if (!NAME_SHAPE.test(name)) throw new RangeError(`secret name ${JSON.stringify(name)} does not match ${SECRET_NAME_PATTERN}`);
};

const createCommandSecretStore = (
  run: SecretProcessPort,
  commands: { read(name: string): SecretCommand; write(name: string, value: string): SecretCommand },
): SecretStore => ({
  read: async (name, signal) => {
    assertNameShape(name);
    const command = commands.read(name);
    const result = await run(command.file, command.args, command.stdin ?? '', signal);
    if (result.exitCode !== 0) throw new SecretUnavailableError(name, result.exitCode, result.stderr.trim(), command.backend);
    const value = withoutOneTrailingNewline(result.stdout);
    if (value === '') throw new SecretEmptyError(name, command.backend);
    return value;
  },
  write: async (name, value, signal) => {
    assertNameShape(name);
    if (value === '') throw new RangeError('a secret value must not be empty');
    const command = commands.write(name, value);
    const result = await run(command.file, command.args, command.stdin ?? '', signal);
    if (result.exitCode !== 0) throw new SecretWriteError(name, result.exitCode, result.stderr.trim(), command.backend);
  },
});

export const keychainWriteCommand = (name: string, value: string): string =>
  `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -X ${Buffer.from(value, 'utf8').toString('hex')}\n`;

export const createKeychainSecretStore = (run: SecretProcessPort, security: string = SECURITY_BINARY): SecretStore =>
  createCommandSecretStore(run, {
    read: (name) => ({
      file: security,
      args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
      backend: KEYCHAIN_BACKEND,
    }),
    write: (name, value) => ({ file: security, args: ['-i'], stdin: keychainWriteCommand(name, value), backend: KEYCHAIN_BACKEND }),
  });

export const createSecretServiceStore = (run: SecretProcessPort, secretTool: string = SECRET_TOOL_BINARY): SecretStore =>
  createCommandSecretStore(run, {
    read: (name) => ({
      file: secretTool,
      args: ['lookup', 'service', KEYCHAIN_SERVICE, 'account', name],
      backend: SECRET_SERVICE_BACKEND,
    }),
    write: (name, value) => ({
      file: secretTool,
      args: ['store', `--label=${KEYCHAIN_SERVICE}`, 'service', KEYCHAIN_SERVICE, 'account', name],
      stdin: value,
      backend: SECRET_SERVICE_BACKEND,
    }),
  });

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

export const createCredentialManagerStore = (run: SecretProcessPort, powershell: { file: string; args(script: string): readonly string[] }): SecretStore =>
  createCommandSecretStore(run, {
    read: (name) => ({
      file: powershell.file,
      args: powershell.args(credentialReadScript(`${KEYCHAIN_SERVICE}/${name}`)),
      backend: CREDENTIAL_MANAGER_BACKEND,
    }),
    write: (name, value) => ({
      file: powershell.file,
      args: powershell.args(credentialWriteScript(`${KEYCHAIN_SERVICE}/${name}`, KEYCHAIN_SERVICE)),
      stdin: value,
      backend: CREDENTIAL_MANAGER_BACKEND,
    }),
  });

type SecretEnv = Readonly<Record<string, string | undefined>>;

type ChosenSecretStore = { kind: 'chosen'; backend: SecretBackend; create(run: SecretProcessPort): SecretStore } | { kind: 'none'; reason: string };

const chooseSecretBackend = (env: SecretEnv): ChosenSecretStore => {
  const security = findProgramOnPath('security', env);
  if (security !== undefined) return { kind: 'chosen', backend: KEYCHAIN_BACKEND, create: (run) => createKeychainSecretStore(run, security) };
  const secretTool = findProgramOnPath('secret-tool', env);
  const busAddress = env['DBUS_SESSION_BUS_ADDRESS'];
  const hasSession = busAddress !== undefined && busAddress !== '';
  if (secretTool !== undefined && hasSession) return { kind: 'chosen', backend: SECRET_SERVICE_BACKEND, create: (run) => createSecretServiceStore(run, secretTool) };
  if (findProgramOnPath('cmdkey', env) !== undefined) {
    return { kind: 'chosen', backend: CREDENTIAL_MANAGER_BACKEND, create: (run) => createCredentialManagerStore(run, { file: powershellPath(env), args: powershellArgs }) };
  }
  const secretServiceState =
    secretTool === undefined ? 'secret-tool (Secret Service) is not on PATH' : `secret-tool (Secret Service) is on PATH at ${secretTool}, but no D-Bus session is set (DBUS_SESSION_BUS_ADDRESS is empty)`;
  return { kind: 'none', reason: `no secret store was found on this host: security (Keychain) is not on PATH; ${secretServiceState}; cmdkey (Credential Manager) is not on PATH` };
};

export const secretStoreChildEnv = (env: SecretEnv): Record<string, string> => {
  const result: Record<string, string> = {};
  const chosen = chooseSecretBackend(env);
  if (chosen.kind === 'none') return result;
  for (const name of chosen.backend.childEnvNames) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
};

const storeFor = (run: SecretProcessPort, env: SecretEnv): SecretStore => {
  const chosen = chooseSecretBackend(env);
  if (chosen.kind === 'none') throw new Error(chosen.reason);
  return chosen.create(run);
};

export const createPlatformSecretStore = (run: SecretProcessPort, env: Readonly<Record<string, string | undefined>>): SecretStore => ({
  read: async (name, signal) => storeFor(run, env).read(name, signal),
  write: async (name, value, signal) => storeFor(run, env).write(name, value, signal),
});
