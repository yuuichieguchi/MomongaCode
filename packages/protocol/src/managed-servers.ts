export const MANAGED_SERVER_ERROR_KINDS = ['guardrail', 'context_overflow', 'payload_too_large', 'unsupported', 'failure'] as const;

export type ManagedServerErrorKind = (typeof MANAGED_SERVER_ERROR_KINDS)[number];

export const PROBE_KEY_COMPONENTS = ['binarySha256', 'hostOsBuild'] as const;

export type ProbeKeyComponent = (typeof PROBE_KEY_COMPONENTS)[number];

export const MANAGED_DECLARABLE_FIELDS = ['contextWindow', 'maxOutputTokens'] as const;

export type ManagedDeclarableField = (typeof MANAGED_DECLARABLE_FIELDS)[number];

export type PreconditionRule =
  | { readonly exitCode: number; readonly verdict: 'met' | 'refused'; readonly message: string; readonly remedy?: string }
  | { readonly otherExit: true; readonly verdict: 'refused'; readonly message: string };

export type Precondition = { readonly argv: readonly string[]; readonly rules: readonly PreconditionRule[] };

export type ManagedTokenCount = { readonly argv: readonly string[]; readonly input: 'stdin'; readonly output: 'integer' } | 'estimated';

export type ManagedRecordedDefaults = {
  readonly stopSequences: boolean;
  readonly imageInput: false;
  readonly tokenCounting: 'estimated' | 'exact';
  readonly usageReported: boolean;
  readonly maxConcurrency: number;
};

export type ManagedServerDescription = {
  readonly id: string;
  readonly provider: string;
  readonly wire: 'chat-completions';
  readonly binary: { readonly defaultPath: string };
  readonly launch: { readonly argv: readonly string[] };
  readonly endpoint: { readonly kind: 'unix' };
  readonly ready: { readonly method: 'GET'; readonly path: string; readonly status: 200; readonly limitMs: number };
  readonly preconditions: readonly Precondition[];
  readonly identity: readonly ProbeKeyComponent[];
  readonly restart: { readonly backoffMs: number; readonly maxRestarts: number; readonly windowMs: number };
  readonly models: { readonly listPath: string; readonly idPath: readonly string[] };
  readonly toolForms: readonly ('envelope' | 'native')[];
  readonly tokenCount: ManagedTokenCount;
  readonly errors: readonly { readonly message: string; readonly kind: ManagedServerErrorKind }[];
  readonly declarable: readonly ManagedDeclarableField[];
  readonly recordedDefaults: ManagedRecordedDefaults;
  readonly sampling: 'none';
};

export const SOCKET_PLACEHOLDER = '{socket}';

export const FM_SERVER = {
  id: 'fm',
  provider: 'apple',
  wire: 'chat-completions',
  binary: { defaultPath: '/usr/bin/fm' },
  launch: { argv: ['serve', '--socket', SOCKET_PLACEHOLDER] },
  endpoint: { kind: 'unix' },
  ready: { method: 'GET', path: '/health', status: 200, limitMs: 10_000 },
  preconditions: [
    {
      argv: ['license', '--status'],
      rules: [
        { exitCode: 0, verdict: 'met', message: 'the Apple Foundation Models licence has been accepted' },
        { exitCode: 69, verdict: 'refused', message: 'the Apple Foundation Models licence has not been accepted', remedy: 'sudo fm license' },
        { otherExit: true, verdict: 'refused', message: 'the Apple Foundation Models licence check failed' },
      ],
    },
    {
      argv: ['available'],
      rules: [
        { exitCode: 0, verdict: 'met', message: 'the Apple system language model is available' },
        { otherExit: true, verdict: 'refused', message: 'the Apple system language model is not available' },
      ],
    },
  ],
  identity: ['binarySha256', 'hostOsBuild'],
  restart: { backoffMs: 1000, maxRestarts: 5, windowMs: 60_000 },
  models: { listPath: '/v1/models', idPath: ['data', '0', 'id'] },
  toolForms: ['envelope'],
  tokenCount: { argv: ['count-tokens', '-q'], input: 'stdin', output: 'integer' },
  errors: [
    { message: "The model's safety guardrails were triggered.", kind: 'guardrail' },
    { message: "The session's transcript exceeded the model's context size.", kind: 'context_overflow' },
    { message: 'An unsupported generation guide was used.', kind: 'unsupported' },
  ],
  declarable: ['contextWindow', 'maxOutputTokens'],
  recordedDefaults: { stopSequences: false, imageInput: false, tokenCounting: 'estimated', usageReported: false, maxConcurrency: 1 },
  sampling: 'none',
} as const satisfies ManagedServerDescription;

export const MANAGED_SERVERS: readonly ManagedServerDescription[] = [FM_SERVER];

export const managedServerOf = (servers: readonly ManagedServerDescription[], id: string): ManagedServerDescription | undefined => servers.find((server) => server.id === id);
