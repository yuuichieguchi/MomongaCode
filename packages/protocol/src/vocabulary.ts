import type { BudgetExhausted } from './budget.ts';
import type { NotRunReason } from './completion.ts';
import type { StopReason } from './run-types.ts';

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

const PRODUCT_WORDS = 'design/protocol-schema.md section 12';
const MODELS = 'design/models.md';
const RELIABILITY = 'design/reliability.md sections 2 to 4';

export const VOCABULARY = {
  product: {
    concept: 'the product, in prose',
    word: 'MomongaCode',
    banned: [{ variant: 'Momonga Code', pattern: 'Momonga Code' }],
    fixedBy: PRODUCT_WORDS,
  },
  command: {
    concept: 'the product, as the command a person types',
    word: 'momonga',
    banned: [],
    fixedBy: PRODUCT_WORDS,
  },
  model: {
    concept: 'a model reached through a connection',
    word: 'model',
    banned: [
      { variant: 'target', pattern: 'targets?', keptFor: 'the wire name of a field or an event key, which no text a person reads contains' },
      { variant: 'endpoint', pattern: 'endpoints?', keptFor: 'the address a connection sends its requests to' },
      { variant: 'backend', pattern: 'backends?', keptFor: 'the sandbox mechanism of the platform' },
    ],
    fixedBy: `${MODELS} section 2.1`,
  },
  connection: {
    concept: 'a set of endpoint settings (the settings key models.connections)',
    word: 'connection',
    banned: [],
    fixedBy: `${MODELS} section 6.2`,
  },
  provider: {
    concept: 'the provider of a model, the first part of its reference',
    word: 'provider',
    banned: [],
    fixedBy: `${MODELS} section 2.2`,
  },
  ownName: {
    concept: 'the name its provider gives a model, the second part of its reference',
    word: 'own name',
    banned: [],
    fixedBy: `${MODELS} section 2.3`,
  },
  server: {
    concept: 'a model server the product starts or finds',
    word: 'server',
    banned: [{ variant: 'gateway', pattern: 'gateways?', keptFor: 'the Model Gateway, the process of the product that routes requests to the models' }],
    fixedBy: `${MODELS} section 3.1`,
  },
  session: {
    concept: 'a stored unit of work that can be reopened',
    word: 'session',
    banned: [{ variant: 'conversation', pattern: 'conversations?', keptFor: 'what a session shows on the screen (design/cli-tui.md section 2)' }],
    fixedBy: PRODUCT_WORDS,
  },
  run: {
    concept: 'one execution of a session',
    word: 'run',
    banned: [{ variant: 'task', pattern: 'tasks?', keptFor: 'a task of the fixed bench task set' }],
    fixedBy: PRODUCT_WORDS,
  },
  folder: {
    concept: 'the folder of a session',
    word: 'folder',
    banned: [
      { variant: 'directory', pattern: 'director(?:y|ies)', keptFor: 'a directory of the file system that is not the folder of a session' },
      { variant: 'project', pattern: 'projects?', keptFor: 'the project layer of the settings and the project check' },
    ],
    fixedBy: PRODUCT_WORDS,
  },
  role: {
    concept: 'the job slot of a model (the settings key models.roles)',
    word: 'role',
    banned: [{ variant: 'job', pattern: 'jobs?', keptFor: 'a background job of a session (momonga jobs)' }],
    fixedBy: `${MODELS} section 7.4`,
  },
  budget: {
    concept: 'the money bound of a run',
    word: 'budget',
    banned: [
      { variant: 'limit', pattern: 'limits?', keptFor: 'the value of one dimension of a budget (the settings key limits) and a bound that is not a budget' },
      { variant: 'ceiling', pattern: 'ceilings?', keptFor: 'the settings key ceilings' },
      { variant: 'cap', pattern: 'caps?', keptFor: 'a bound of size that is not a budget' },
    ],
    fixedBy: 'design/tools.md section 3.3',
  },
  mandate: {
    concept: 'the named bundle of bounds and permissions of a delegated run',
    word: 'mandate',
    banned: [{ variant: 'profile', pattern: 'profiles?', keptFor: 'a plan profile of design/sign-in.md section 1.6 and the sandbox profile of the platform' }],
    fixedBy: 'design/tools.md section 4.1',
  },
  eval: {
    concept: 'a measurement over a dataset',
    word: 'eval',
    banned: [{ variant: 'evaluation', pattern: 'evaluations?', keptFor: 'prose that names no command' }],
    fixedBy: RELIABILITY,
  },
  reliability: {
    concept: 'the report of real runs',
    word: 'reliability',
    banned: [],
    fixedBy: RELIABILITY,
  },
  bench: {
    concept: 'the measurement over the fixed task set',
    word: 'bench',
    banned: [{ variant: 'benchmark', pattern: 'benchmarks?', keptFor: 'prose that names no command' }],
    fixedBy: RELIABILITY,
  },
  daemon: {
    concept: 'the background process of the product',
    word: 'daemon',
    banned: [{ variant: 'background service', pattern: 'background services?' }],
    fixedBy: 'design/supervisor-update.md section 2.6',
  },
  compaction: {
    concept: 'the shortening of the context of a session',
    word: 'compaction',
    banned: [
      { variant: 'compact', pattern: 'compact', keptFor: 'the verb in a command or key name' },
      { variant: 'summaries', pattern: 'summaries', keptFor: 'summaries that are not of a compaction' },
    ],
    fixedBy: 'design/context.md section 4',
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

const SHELL_PLAIN_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const shellQuote = (argument: string, platform: string): string => {
  if (SHELL_PLAIN_ARGUMENT.test(argument)) return argument;
  return platform === 'win32' ? `"${argument.replaceAll('"', '\\"')}"` : `'${argument.replaceAll("'", "'\\''")}'`;
};

export const BYPASS_OPT_IN_OPTION = '--dangerously-skip-permissions';

export const PERMISSION_MODE_OPTION = '--permission-mode';

export const PRINT_OPTION = '--print';

export const reopenSessionCommand = (sessionId: string): string => `${WORDS.command} --resume ${sessionId}`;

export const CHOOSE_SESSION_COMMAND = `${WORDS.command} --resume`;

export const attachRunCommand = (runId: string): string => `${WORDS.command} attach ${runId}`;

export const ADD_MODEL_COMMAND = `${WORDS.command} models add`;

export const SIGN_IN_COMMAND = `${WORDS.command} auth login`;

export const TUI_SIGN_IN_COMMAND = '/login';

export const signOutCommand = (account: string): string => `${WORDS.command} auth logout ${account}`;

export const TUI_SIGN_OUT_COMMAND = '/logout';

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

const billingChangeRemedy = (surface: Surface, from: string, to: string): string => (surface === 'tui' ? '/models billing' : `${WORDS.command} models billing allow ${from} ${to}`);

export const withBillingRemedy = (notice: string, surface: Surface, from: string, to: string): string => `${notice} Run ${billingChangeRemedy(surface, from, to)}.`;

const SIGN_IN_AGAIN_COMMAND: Readonly<Record<Surface, string>> = {
  cli: SIGN_IN_COMMAND,
  tui: TUI_SIGN_IN_COMMAND,
  acp: SIGN_IN_COMMAND,
  gateway: SIGN_IN_COMMAND,
};

export const withSignInRemedy = (notice: string, surface: Surface): string => `${notice} Run ${SIGN_IN_AGAIN_COMMAND[surface]} to sign in again.`;

const COUNT_WORDS: Readonly<Record<number, string>> = { 2: 'two', 3: 'three' };

export const serverCountText = (count: number): string => COUNT_WORDS[count] ?? String(count);

const noModelConnected = (surface: Surface): string => `No ${WORDS.model} is connected. ${CONNECT_MODEL_REMEDY[surface]}`;

const STOP_WORDS: Readonly<Record<StopReason, string>> = {
  max_steps: 'step limit reached',
  budget: 'budget limit reached',
  max_tokens: 'token limit reached',
  timeout: 'time limit reached',
  loop: 'repeated tool calls',
  approval_timeout: 'no answer to an approval',
  refusal: 'refused by the model',
  usage_limit: 'usage limit reached',
  conditions_unmet: 'completion conditions not met',
};

export const stopWord = (reason: StopReason): string => STOP_WORDS[reason];

const NOT_RUN_WORDS: Readonly<Record<NotRunReason, string>> = {
  max_steps: 'the step limit was reached',
  budget: 'the budget limit was reached',
  max_tokens: 'the token limit was reached',
  timeout: 'the time limit was reached',
  loop: 'the run looped',
  approval_timeout: 'no approval was given in time',
  refusal: 'the model refused',
  usage_limit: 'the usage limit was reached',
  cancelled: 'the run was cancelled',
  failed: 'the run failed',
  not_needed: 'it was not needed',
  no_mechanical_check: 'no mechanical check exists',
  unfinished: 'the run did not finish',
};

export const notRunWord = (reason: NotRunReason): string => NOT_RUN_WORDS[reason];

const DIMENSION_WORDS: Readonly<Record<BudgetExhausted['dimension'], string>> = { steps: 'step', tokens: 'token', cost: 'money', time: 'time', retries: 'retry' };

export const budgetSentence = (exhausted: BudgetExhausted, format: (dimension: BudgetExhausted['dimension'], value: number) => string): string => {
  const what = DIMENSION_WORDS[exhausted.dimension];
  const figures = `${format(exhausted.dimension, exhausted.spent)} of ${format(exhausted.dimension, exhausted.limit)} used or reserved`;
  if (exhausted.cause === 'unpriced') return `The run stopped at its ${what} limit: a model call has no price, so its cost cannot be counted (${figures}).`;
  if (exhausted.cause === 'cap_too_small') {
    const admits = exhausted.admitsAt === undefined ? '' : ` A budget of ${format(exhausted.dimension, exhausted.admitsAt)} admits the next model request.`;
    return `The run stopped at its ${what} limit: what is left does not pay for another model request (${figures}).${admits}`;
  }
  return `The run stopped at its ${what} limit (${figures}).`;
};

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
  sessionInOtherFolder: [given: { readonly id: string; readonly folder: string; readonly platform: string }];
  noSessionToContinue: [given: { readonly folder: string }];
  notAnId: [given: { readonly value: string }];
  storedBypassNeedsOptIn: [given: { readonly id: string }];
  optionNeedsPrint: [given: { readonly option: string }];
  optionNeedsInteractive: [given: { readonly option: string }];
  promptGivenTwice: [given: { readonly prompt: string }];
  issueNeedsMandate: [];
  issueBesidePrompt: [];
  resumeNeedsIdToPrint: [];
  bypassNotStarted: [given: { readonly id: string }];
  handoverFailed: [given: { readonly toVersion: string; readonly fromVersion: string; readonly reason: string; readonly kept: KeptWork }];
  restoreRefused: [given: { readonly reason: string; readonly kept: KeptWork }];
  aboutModel: [given: { readonly model: string; readonly text: string }];
  modelNotReady: [given: { readonly model: string; readonly reason: string }];
  modelIdChanged: [given: { readonly server: string; readonly model: string; readonly listed: string; readonly entry: string }];
  serverSocketPathTooLong: [given: { readonly model: string; readonly byteLength: number; readonly directory: string; readonly code: string }];
  signInIdentityQuestion: [given: { readonly provider: string; readonly identity: string; readonly account: string }];
  signInIdentityNotConfirmed: [given: { readonly identity: string; readonly account: string; readonly command: string }];
  planRecordUnreadable: [given: { readonly account: string; readonly cause: string | undefined; readonly signInCommand: string }];
  accountWithoutModel: [given: { readonly provider: string; readonly account: string }];
  serverFormNotOffered: [given: { readonly server: string; readonly platform: string; readonly accepted: readonly string[]; readonly offered: readonly string[] }];
  daemonStarting: [];
  billingChangeRefused: [given: { readonly model: string; readonly from: string; readonly to: string }];
};

export type MessageKey = keyof MessageInputs;

export type MessageInput<Key extends MessageKey> = MessageInputs[Key];

export const billingChangeRefusedSentence = (given: { readonly model: string; readonly from: string; readonly to: string }): string =>
  `Did not fall back to ${given.model}: billing from ${given.from} to ${given.to} is not allowed.`;

const MESSAGES: { readonly [Key in MessageKey]: (surface: Surface, ...given: MessageInputs[Key]) => string } = {
  noModelConnected,
  modelAmbiguous: (_surface, given) => `The ${WORDS.model} "${given.text}" is served by ${serverCountText(given.choices.length)} ${WORDS.server}s: ${given.choices.join(', ')}. Write one of them.`,
  modelNotConfigured: (surface, given) =>
    `The ${WORDS.model} "${given.text}" is not configured. ${given.choices.length === 0 ? noModelConnected(surface) : `Configured ${WORDS.model}s: ${given.choices.join(', ')}.`}`,
  sessionNotFound: (_surface, given) => `No ${WORDS.session} has the id ${given.id}.`,
  sessionIdTooShort: (_surface, given) => `No ${WORDS.session} has the id ${given.id}. A shortened id needs at least ${given.minimum} characters.`,
  sessionAmbiguous: (_surface, given) => `${given.id} matches more than one ${WORDS.session}: ${given.matches.join(', ')}`,
  sessionInOtherFolder: (_surface, given) => `That ${WORDS.session} belongs to the ${WORDS.folder} ${given.folder}. Run: cd ${shellQuote(given.folder, given.platform)} && ${reopenSessionCommand(given.id)}`,
  optionNeedsPrint: (_surface, given) => `${given.option} applies only with ${PRINT_OPTION}; the interactive ${WORDS.session} cannot apply it.`,
  optionNeedsInteractive: (_surface, given) => `${given.option} applies only to the interactive ${WORDS.session}; it cannot be given with ${PRINT_OPTION}.`,
  promptGivenTwice: (_surface, given) => `${PRINT_OPTION} takes the prompt as its value, so ${JSON.stringify(given.prompt)} cannot be given as well.`,
  issueNeedsMandate: () =>
    `--issue starts a ${WORDS.run} that acts on the forge, so it runs only under a named mandate: add --mandate <name>, the name of a mandate under mandates in the user settings.`,
  issueBesidePrompt: () => `--issue takes the words of the ${WORDS.run} from the issue, so it cannot be given with ${PRINT_OPTION} or a prompt of its own.`,
  resumeNeedsIdToPrint: () => `--resume needs a ${WORDS.session} id when ${PRINT_OPTION} is used.`,
  storedBypassNeedsOptIn: (_surface, given) =>
    `The ${WORDS.session} ${given.id} is stored in the bypassPermissions mode, and this command does not give ${BYPASS_OPT_IN_OPTION}. Reopen it with ${BYPASS_OPT_IN_OPTION} to stay in that mode, or with ${PERMISSION_MODE_OPTION} <mode> to leave it.`,
  bypassNotStarted: (_surface, given) =>
    `The ${WORDS.session} ${given.id} was not started with ${BYPASS_OPT_IN_OPTION}, so a resume cannot move it into the bypassPermissions mode. Start a new ${WORDS.session} with ${BYPASS_OPT_IN_OPTION}.`,
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
  signInIdentityQuestion: (_surface, given) => `The sign-in at ${given.provider} is for ${given.identity}. Save this account under the label ${given.account}?`,
  signInIdentityNotConfirmed: (surface, given) =>
    `The sign-in for ${given.identity} was not saved under the label ${given.account}, because the account was not confirmed. Run ${given.command} to sign in again${SIGN_IN_AGAIN_UNASKED[surface]}.`,
  planRecordUnreadable: (surface, given) =>
    `The saved record of ${given.account} cannot be read${given.cause === undefined ? '' : ` (${given.cause})`}. Run ${given.signInCommand} to replace it with a new sign-in, or ${forgetRecordCommand(surface, given.account)} to forget it on this computer; forgetting it does not revoke the session at the provider.`,
  accountWithoutModel: (surface, given) => `No ${WORDS.model} uses this account yet. ${ACCOUNT_MODEL_STEP[surface](given)}`,
  serverFormNotOffered: (_surface, given) =>
    `the ${WORDS.server} ${JSON.stringify(given.server)} cannot be used on ${given.platform}: it accepts only the socket forms [${given.accepted.join(', ')}], and ${given.platform} offers [${given.offered.join(', ')}]`,
  billingChangeRefused: (_surface, given) => billingChangeRefusedSentence(given),
  daemonStarting: () => `The ${WORDS.daemon} is still starting and accepts no new work yet. The request was not run; send it again.`,
};

const ACCOUNT_MODEL_STEP: Readonly<Record<Surface, (given: { readonly provider: string; readonly account: string }) => string>> = {
  cli: (given) => `Run ${WORDS.command} models catalog ${given.account} to list its ${WORDS.model}s, then ${ADD_MODEL_COMMAND} --plan ${given.provider} --account ${given.account} --model <${WORDS.ownName}> --yes to add one.`,
  tui: () => `Use /model to choose one of its ${WORDS.model}s.`,
  acp: (given) => ACCOUNT_MODEL_STEP.cli(given),
  gateway: (given) => ACCOUNT_MODEL_STEP.cli(given),
};

const forgetRecordCommand = (surface: Surface, account: string): string => (surface === 'tui' ? TUI_SIGN_OUT_COMMAND : signOutCommand(account));

const SIGN_IN_AGAIN_UNASKED: Readonly<Record<Surface, string>> = {
  cli: ', or add --yes to save the account without the question',
  tui: '',
  acp: '',
  gateway: '',
};

export const MESSAGE_KEYS = Object.keys(MESSAGES) as readonly MessageKey[];

export const messageOf = <Key extends MessageKey>(key: Key, surface: Surface, ...given: MessageInputs[Key]): string => MESSAGES[key](surface, ...given);
