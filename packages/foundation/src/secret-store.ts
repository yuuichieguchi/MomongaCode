import { UnsupportedPlatformError } from './platform/process-inspector.ts';
import { powershellArgs, powershellPath } from './platform/windows-scripts.ts';

export const SECRET_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export const KEYCHAIN_SERVICE = 'momonga';
export const SECURITY_BINARY = '/usr/bin/security';

export type SecretStore = {
  read(name: string, signal: AbortSignal): Promise<string>;
};

export type SecretProcessResult = { exitCode: number; stdout: string; stderr: string };

export type SecretProcessPort = (file: string, args: readonly string[], stdin: string, signal: AbortSignal) => Promise<SecretProcessResult>;

export type SecretBackend = { label: string; storeCommand(secretName: string): string };

export const KEYCHAIN_BACKEND: SecretBackend = {
  label: 'Keychain',
  storeCommand: (secretName) => `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${secretName} -w`,
};

export const SECRET_SERVICE_BACKEND: SecretBackend = {
  label: 'Secret Service',
  storeCommand: (secretName) => `secret-tool store --label=${KEYCHAIN_SERVICE} service ${KEYCHAIN_SERVICE} account ${secretName}`,
};

export const CREDENTIAL_MANAGER_BACKEND: SecretBackend = {
  label: 'Credential Manager',
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

const createCommandSecretStore = (run: SecretProcessPort, commandFor: (name: string) => SecretCommand): SecretStore => ({
  read: async (name, signal) => {
    if (!NAME_SHAPE.test(name)) throw new RangeError(`secret name ${JSON.stringify(name)} does not match ${SECRET_NAME_PATTERN}`);
    const command = commandFor(name);
    const result = await run(command.file, command.args, command.stdin ?? '', signal);
    if (result.exitCode !== 0) throw new SecretUnavailableError(name, result.exitCode, result.stderr.trim(), command.backend);
    const value = withoutOneTrailingNewline(result.stdout);
    if (value === '') throw new SecretEmptyError(name, command.backend);
    return value;
  },
});

export const createKeychainSecretStore = (run: SecretProcessPort): SecretStore =>
  createCommandSecretStore(run, (name) => ({
    file: SECURITY_BINARY,
    args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
    backend: KEYCHAIN_BACKEND,
  }));

export const createSecretServiceStore = (run: SecretProcessPort): SecretStore =>
  createCommandSecretStore(run, (name) => ({
    file: SECRET_TOOL_BINARY,
    args: ['lookup', 'service', KEYCHAIN_SERVICE, 'account', name],
    backend: SECRET_SERVICE_BACKEND,
  }));

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

export const createCredentialManagerStore = (run: SecretProcessPort, powershell: { file: string; args(script: string): readonly string[] }): SecretStore =>
  createCommandSecretStore(run, (name) => ({
    file: powershell.file,
    args: powershell.args(credentialReadScript(`${KEYCHAIN_SERVICE}/${name}`)),
    backend: CREDENTIAL_MANAGER_BACKEND,
  }));

export const createPlatformSecretStore = (
  platform: NodeJS.Platform,
  run: SecretProcessPort,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretStore => {
  switch (platform) {
    case 'darwin':
      return createKeychainSecretStore(run);
    case 'linux':
      return createSecretServiceStore(run);
    case 'win32':
      return createCredentialManagerStore(run, { file: powershellPath(env), args: powershellArgs });
    default:
      throw new UnsupportedPlatformError(platform, 'secret storage');
  }
};
