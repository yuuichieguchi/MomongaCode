export const HELPER_COMMAND = '__helper';

export type HelperHost = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
};

export type ExecutableHelper = (host: HelperHost) => Promise<number>;

export type ExecutableHelpers = Readonly<Record<string, ExecutableHelper>>;

export type HelperSelf = { readonly execPath: string; readonly script?: string };

export const helperCommandLine = (self: HelperSelf, name: string, args: readonly string[]): string[] => [
  self.execPath,
  ...(self.script === undefined ? [] : [self.script]),
  HELPER_COMMAND,
  name,
  ...args,
];
