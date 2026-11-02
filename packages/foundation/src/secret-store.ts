export const SECRET_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export const KEYCHAIN_SERVICE = 'momonga';
export const SECURITY_BINARY = '/usr/bin/security';

export type SecretStore = {
  read(name: string, signal: AbortSignal): Promise<string>;
};

export type SecretProcessResult = { exitCode: number; stdout: string; stderr: string };

export type SecretProcessPort = (file: string, args: readonly string[], stdin: string, signal: AbortSignal) => Promise<SecretProcessResult>;

export class SecretUnavailableError extends Error {
  readonly secretName: string;
  readonly exitCode: number;

  constructor(secretName: string, exitCode: number, detail: string) {
    super(
      `the secret "${secretName}" could not be read from the Keychain (exit ${exitCode}${detail === '' ? '' : `: ${detail}`}); store it with: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${secretName} -w`,
    );
    this.name = 'SecretUnavailableError';
    this.secretName = secretName;
    this.exitCode = exitCode;
  }
}

export class SecretEmptyError extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`the secret "${secretName}" is empty in the Keychain`);
    this.name = 'SecretEmptyError';
    this.secretName = secretName;
  }
}

const NAME_SHAPE = new RegExp(SECRET_NAME_PATTERN);

const withoutOneTrailingNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

export const createKeychainSecretStore = (run: SecretProcessPort): SecretStore => ({
  read: async (name, signal) => {
    if (!NAME_SHAPE.test(name)) throw new RangeError(`secret name ${JSON.stringify(name)} does not match ${SECRET_NAME_PATTERN}`);
    const result = await run(SECURITY_BINARY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], '', signal);
    if (result.exitCode !== 0) throw new SecretUnavailableError(name, result.exitCode, result.stderr.trim());
    const value = withoutOneTrailingNewline(result.stdout);
    if (value === '') throw new SecretEmptyError(name);
    return value;
  },
});
