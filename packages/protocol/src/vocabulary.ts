export const SURFACES = ['cli', 'tui', 'acp', 'gateway'] as const;

export type Surface = (typeof SURFACES)[number];

export type BannedVariant = {
  readonly variant: string;
  readonly pattern: string;
  readonly keptFor?: string;
};

export type VocabularyRow = {
  readonly concept: string;
  readonly word: string;
  readonly banned: readonly BannedVariant[];
  readonly fixedBy: string;
};

const RULED = 'ruling-2026-11-11.md cli-commands DECISION-10';
const MODEL_NAMES = 'design-model-names-2026-11-10.md';
const BUDGET_DELEGATION = 'design-gitpr-budget-delegation.md';

export const VOCABULARY = {
  product: {
    concept: 'the product, in prose',
    word: 'MomongaCode',
    banned: [{ variant: 'Momonga Code', pattern: 'Momonga Code' }],
    fixedBy: RULED,
  },
  command: {
    concept: 'the product, as the command a person types',
    word: 'momonga',
    banned: [],
    fixedBy: RULED,
  },
  model: {
    concept: 'a model reached through a connection',
    word: 'model',
    banned: [
      { variant: 'target', pattern: 'targets?', keptFor: 'the wire name of a field or an event key, which no text a person reads contains' },
      { variant: 'endpoint', pattern: 'endpoints?', keptFor: 'the address a connection sends its requests to' },
      { variant: 'backend', pattern: 'backends?', keptFor: 'the sandbox mechanism of the platform' },
    ],
    fixedBy: `${MODEL_NAMES}:110`,
  },
  connection: {
    concept: 'a set of endpoint settings (the settings key models.connections)',
    word: 'connection',
    banned: [],
    fixedBy: `${MODEL_NAMES} 2.3`,
  },
  provider: {
    concept: 'the provider of a model, the first part of its reference',
    word: 'provider',
    banned: [],
    fixedBy: `${MODEL_NAMES} 2.1`,
  },
  ownName: {
    concept: 'the name its provider gives a model, the second part of its reference',
    word: 'own name',
    banned: [],
    fixedBy: `${MODEL_NAMES}:1`,
  },
  server: {
    concept: 'a model server the product starts or finds',
    word: 'server',
    banned: [{ variant: 'gateway', pattern: 'gateways?', keptFor: 'the Model Gateway, the process of the product that routes requests to the models' }],
    fixedBy: `${RULED}; ${MODEL_NAMES} 2.8`,
  },
  session: {
    concept: 'a stored unit of work that can be reopened',
    word: 'session',
    banned: [{ variant: 'conversation', pattern: 'conversations?', keptFor: 'what a session shows on the screen (design-screens-2026-11-10.md:51)' }],
    fixedBy: RULED,
  },
  run: {
    concept: 'one execution of a session',
    word: 'run',
    banned: [{ variant: 'task', pattern: 'tasks?', keptFor: 'a task of the fixed bench task set' }],
    fixedBy: RULED,
  },
  folder: {
    concept: 'the folder of a session',
    word: 'folder',
    banned: [
      { variant: 'directory', pattern: 'director(?:y|ies)', keptFor: 'a directory of the file system that is not the folder of a session' },
      { variant: 'project', pattern: 'projects?', keptFor: 'the project layer of the settings and the project check' },
    ],
    fixedBy: RULED,
  },
  role: {
    concept: 'the job slot of a model (the settings key models.roles)',
    word: 'role',
    banned: [{ variant: 'job', pattern: 'jobs?', keptFor: 'a background job of a session (momonga jobs)' }],
    fixedBy: `${MODEL_NAMES}:26-27`,
  },
  budget: {
    concept: 'the money bound of a run',
    word: 'budget',
    banned: [
      { variant: 'limit', pattern: 'limits?', keptFor: 'the value of one dimension of a budget (the settings key limits) and a bound that is not a budget' },
      { variant: 'ceiling', pattern: 'ceilings?', keptFor: 'the settings key ceilings' },
      { variant: 'cap', pattern: 'caps?', keptFor: 'a bound of size that is not a budget' },
    ],
    fixedBy: `${BUDGET_DELEGATION} (budget.exhausted)`,
  },
  mandate: {
    concept: 'the named bundle of bounds and permissions of a delegated run',
    word: 'mandate',
    banned: [{ variant: 'profile', pattern: 'profiles?', keptFor: 'a plan profile of design-chatgpt-plan.md and the sandbox profile of the platform' }],
    fixedBy: `${BUDGET_DELEGATION}:333`,
  },
  eval: {
    concept: 'a measurement over a dataset',
    word: 'eval',
    banned: [{ variant: 'evaluation', pattern: 'evaluations?', keptFor: 'prose that names no command' }],
    fixedBy: 'design-reliability-report.md:1',
  },
  reliability: {
    concept: 'the report of real runs',
    word: 'reliability',
    banned: [],
    fixedBy: 'design-reliability-report.md:1',
  },
  bench: {
    concept: 'the measurement over the fixed task set',
    word: 'bench',
    banned: [{ variant: 'benchmark', pattern: 'benchmarks?', keptFor: 'prose that names no command' }],
    fixedBy: 'design-reliability-report.md:1',
  },
  daemon: {
    concept: 'the background process of the product',
    word: 'daemon',
    banned: [{ variant: 'background service', pattern: 'background services?' }],
    fixedBy: 'design-update-no-interrupt-2026-11-07.md:2218',
  },
  compaction: {
    concept: 'the shortening of the context of a session',
    word: 'compaction',
    banned: [
      { variant: 'compact', pattern: 'compact', keptFor: 'the verb in a command or key name' },
      { variant: 'summaries', pattern: 'summaries', keptFor: 'summaries that are not of a compaction' },
    ],
    fixedBy: 'design-fix-compaction.md',
  },
} as const satisfies Readonly<Record<string, VocabularyRow>>;

export type Concept = keyof typeof VOCABULARY;

export const CONCEPTS = Object.keys(VOCABULARY) as readonly Concept[];

export const WORDS: { readonly [K in Concept]: (typeof VOCABULARY)[K]['word'] } = {
  product: VOCABULARY.product.word,
  command: VOCABULARY.command.word,
  model: VOCABULARY.model.word,
  connection: VOCABULARY.connection.word,
  provider: VOCABULARY.provider.word,
  ownName: VOCABULARY.ownName.word,
  server: VOCABULARY.server.word,
  session: VOCABULARY.session.word,
  run: VOCABULARY.run.word,
  folder: VOCABULARY.folder.word,
  role: VOCABULARY.role.word,
  budget: VOCABULARY.budget.word,
  mandate: VOCABULARY.mandate.word,
  eval: VOCABULARY.eval.word,
  reliability: VOCABULARY.reliability.word,
  bench: VOCABULARY.bench.word,
  daemon: VOCABULARY.daemon.word,
  compaction: VOCABULARY.compaction.word,
};

export type BannedUse = { readonly concept: Concept; readonly word: string; readonly variant: string; readonly keptFor: string | undefined };

type BannedMatcher = BannedUse & { readonly expression: RegExp };

const BANNED_MATCHERS: readonly BannedMatcher[] = CONCEPTS.flatMap((concept) => {
  const row: VocabularyRow = VOCABULARY[concept];
  return row.banned.map((banned) => ({ concept, word: row.word, variant: banned.variant, keptFor: banned.keptFor, expression: new RegExp(`\\b(?:${banned.pattern})\\b`, 'i') }));
});

export const bannedVariantsIn = (text: string): BannedUse[] =>
  BANNED_MATCHERS.filter((matcher) => matcher.expression.test(text)).map(({ concept, word, variant, keptFor }) => ({ concept, word, variant, keptFor }));

export const reopenSessionCommand = (sessionId: string): string => `${WORDS.command} --resume ${sessionId}`;

export const CHOOSE_SESSION_COMMAND = `${WORDS.command} --resume`;

export const attachRunCommand = (runId: string): string => `${WORDS.command} attach ${runId}`;

export const ADD_MODEL_COMMAND = `${WORDS.command} models add`;

export const SIGN_IN_COMMAND = `${WORDS.command} auth login`;

export const TUI_SIGN_IN_COMMAND = '/login';

export type KeptWork = { readonly kind: 'sessions'; readonly sessionIds: readonly string[] } | { readonly kind: 'run'; readonly runId: string } | { readonly kind: 'unnamed' };

const keptCommandsOf = (kept: KeptWork): readonly string[] => {
  switch (kept.kind) {
    case 'sessions':
      return kept.sessionIds.map(reopenSessionCommand);
    case 'run':
      return [attachRunCommand(kept.runId)];
    case 'unnamed':
      return [CHOOSE_SESSION_COMMAND];
  }
};

const quotedCommands = (commands: readonly string[]): string => commands.map((command) => `\`${command}\``).join(', ');

const SHELL_CONNECT_MODEL_REMEDY = `Run ${ADD_MODEL_COMMAND} to add one, or ${SIGN_IN_COMMAND} to sign in.`;

const CONNECT_MODEL_REMEDY: Readonly<Record<Surface, string>> = {
  cli: SHELL_CONNECT_MODEL_REMEDY,
  tui: `Use ${TUI_SIGN_IN_COMMAND} to connect one.`,
  acp: SHELL_CONNECT_MODEL_REMEDY,
  gateway: SHELL_CONNECT_MODEL_REMEDY,
};

const COUNT_WORDS: Readonly<Record<number, string>> = { 2: 'two', 3: 'three' };

export const serverCountText = (count: number): string => COUNT_WORDS[count] ?? String(count);

const noModelConnected = (surface: Surface): string => `No ${WORDS.model} is connected. ${CONNECT_MODEL_REMEDY[surface]}`;

const UNSENT_INPUT_KEPT: Readonly<Record<Surface, string>> = {
  cli: '',
  tui: ' Your unsent input is still in the prompt.',
  acp: '',
  gateway: '',
};

const keptRunsSentence = (kept: KeptWork): string => {
  const commands = keptCommandsOf(kept);
  return commands.length === 0 ? '' : ` Your ${WORDS.run}s keep going; open them with ${quotedCommands(commands)}.`;
};

const keptSessionSentence = (kept: KeptWork): string => {
  const commands = keptCommandsOf(kept);
  return commands.length === 0 ? '' : ` Your work is kept: run ${quotedCommands(commands)}.`;
};

type ModelChoices = { readonly text: string; readonly choices: readonly string[] };

export type MessageInputs = {
  noModelConnected: [];
  modelAmbiguous: [given: ModelChoices];
  modelNotConfigured: [given: ModelChoices];
  sessionNotFound: [given: { readonly id: string }];
  sessionIdTooShort: [given: { readonly id: string; readonly minimum: number }];
  sessionAmbiguous: [given: { readonly id: string; readonly matches: readonly string[] }];
  sessionInOtherFolder: [given: { readonly id: string; readonly folder: string }];
  noSessionToContinue: [given: { readonly folder: string }];
  notAnId: [given: { readonly value: string }];
  handoverFailed: [given: { readonly toVersion: string; readonly fromVersion: string; readonly reason: string; readonly kept: KeptWork }];
  restoreRefused: [given: { readonly reason: string; readonly kept: KeptWork }];
  aboutModel: [given: { readonly model: string; readonly text: string }];
  modelNotReady: [given: { readonly model: string; readonly reason: string }];
  modelIdChanged: [given: { readonly server: string; readonly model: string; readonly listed: string; readonly entry: string }];
  serverSocketPathTooLong: [given: { readonly model: string; readonly byteLength: number; readonly directory: string; readonly code: string }];
  serverFormNotOffered: [given: { readonly server: string; readonly platform: string; readonly accepted: readonly string[]; readonly offered: readonly string[] }];
  daemonStarting: [];
};

export type MessageKey = keyof MessageInputs;

export type MessageInput<Key extends MessageKey> = MessageInputs[Key];

const MESSAGES: { readonly [Key in MessageKey]: (surface: Surface, ...given: MessageInputs[Key]) => string } = {
  noModelConnected,
  modelAmbiguous: (_surface, given) => `The ${WORDS.model} "${given.text}" is served by ${serverCountText(given.choices.length)} ${WORDS.server}s: ${given.choices.join(', ')}. Write one of them.`,
  modelNotConfigured: (surface, given) =>
    `The ${WORDS.model} "${given.text}" is not configured. ${given.choices.length === 0 ? noModelConnected(surface) : `Configured ${WORDS.model}s: ${given.choices.join(', ')}.`}`,
  sessionNotFound: (_surface, given) => `No ${WORDS.session} has the id ${given.id}.`,
  sessionIdTooShort: (_surface, given) => `No ${WORDS.session} has the id ${given.id}. A shortened id needs at least ${given.minimum} characters.`,
  sessionAmbiguous: (_surface, given) => `${given.id} matches more than one ${WORDS.session}: ${given.matches.join(', ')}`,
  sessionInOtherFolder: (_surface, given) => `That ${WORDS.session} belongs to the ${WORDS.folder} ${given.folder}. Run: cd ${given.folder} && ${reopenSessionCommand(given.id)}`,
  notAnId: (_surface, given) => `${JSON.stringify(given.value)} is not an id.`,
  noSessionToContinue: (_surface, given) => `No ${WORDS.session} to continue in the ${WORDS.folder} ${given.folder}.`,
  handoverFailed: (surface, given) =>
    `Could not restart into v${given.toVersion} (${given.reason}). This ${WORDS.session} stays on v${given.fromVersion} and keeps working until that version finishes its ${WORDS.run}s.${keptRunsSentence(given.kept)}${UNSENT_INPUT_KEPT[surface]}`,
  restoreRefused: (_surface, given) => `Could not restore the ${WORDS.session} (${given.reason}).${keptSessionSentence(given.kept)}`,
  aboutModel: (_surface, given) => `the ${WORDS.model} "${given.model}": ${given.text}`,
  modelNotReady: (_surface, given) => `the ${WORDS.model} "${given.model}" is not ready: ${given.reason}`,
  modelIdChanged: (_surface, given) =>
    `The ${WORDS.server} ${given.server} of the ${WORDS.model} ${given.model} lists "${given.listed}", not "${given.entry}". Run /models add to add the ${WORDS.model} it serves now.`,
  serverSocketPathTooLong: (surface, given) =>
    MESSAGES.aboutModel(surface, {
      model: given.model,
      text: `its ${WORDS.server} socket path is ${given.byteLength} bytes, and the system refused to bind a socket path of that length in ${given.directory} (${given.code}); choose a shorter ${WORDS.server} name`,
    }),
  serverFormNotOffered: (_surface, given) =>
    `the ${WORDS.server} ${JSON.stringify(given.server)} cannot be used on ${given.platform}: it accepts only the socket forms [${given.accepted.join(', ')}], and ${given.platform} offers [${given.offered.join(', ')}]`,
  daemonStarting: () => `The ${WORDS.daemon} is still starting and accepts no new work yet. The request was not run; send it again.`,
};

export const MESSAGE_KEYS = Object.keys(MESSAGES) as readonly MessageKey[];

export const messageOf = <Key extends MessageKey>(key: Key, surface: Surface, ...given: MessageInputs[Key]): string => MESSAGES[key](surface, ...given);
