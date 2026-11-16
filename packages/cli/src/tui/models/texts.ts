import { LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';

export const MODELS_TITLE = 'Models';
export const ADD_TITLE = 'Add a model';

export const SEARCH_ROW = 'Search this computer for model servers';
export const TYPE_ADDRESS_ROW = 'Type the address of a model server';
export const SERVICE_ROW = 'Use a service with an API key';
export const PROGRAM_ROW = 'Run a program as a model server';
export const BACK_ROW = 'Back';

export const builtInServerRow = (label: string): string => `Use ${label}`;

export const SEARCHING_PHASE = 'searching for model servers';
export const CHECKING_PHASE = 'checking the servers';
export const SAVING_PHASE = 'saving the setting';

export const windowPrompt = (display: string, ceiling: number | undefined): string => (ceiling === undefined ? `Context window for ${display}:` : `Context window for ${display} (at most ${ceiling}):`);

export { windowProblem } from '../../models-check.ts';

const [EXAMPLE_ADDRESS] = LOCAL_SERVER_CANDIDATES;

export const ADDRESS_PROMPT = `Address (for example ${EXAMPLE_ADDRESS}):`;
export const NOT_AN_ADDRESS = `Not an address. Write it like ${EXAMPLE_ADDRESS}.`;
export const SERVICE_ADDRESS_PROMPT = 'Address:';
export const MODEL_NAME_PROMPT = 'Model name as the server calls it:';
export const MODEL_NAME_PROBLEM = 'Write the name of the model.';

export const API_ROWS = [
  { label: 'Ollama API', adapter: 'ollama' },
  { label: 'OpenAI-compatible API', adapter: 'chat-completions' },
  { label: 'Anthropic API', adapter: 'anthropic' },
  { label: 'OpenAI Responses API', adapter: 'open-responses' },
] as const;

export const SERVICE_API_ROWS = API_ROWS.filter((row) => row.adapter !== 'ollama');

export const KEY_TITLE = 'Key';
export const SAVING_KEY_PHASE = 'saving the key';
export const KEY_ENV_ROW = 'Read the key from an environment variable';
export const KEY_SECRET_ROW = 'Save the key in the system secret store';
export const KEY_ENV_PROMPT = 'Name of the environment variable (for example OPENAI_API_KEY):';
export const KEY_ENV_PROBLEM = 'A variable name uses letters, digits and _ and does not start with a digit.';
export const KEY_PROMPT = 'Key:';
export const KEY_PROBLEM = 'Write the key.';
export const SERVICE_NAME_PROMPT = 'Name of the service, used for prices (for example openai; Enter to skip):';
export const NAME_PROBLEM = 'Use lower-case letters, digits, . _ - and start with a lower-case letter.';

export const PROGRAM_PATH_PROMPT = 'Write the full path of the program.';
export const NOT_A_FULL_PATH = 'That is not a full path.';
export const PROGRAM_ARGUMENTS_PROMPT = 'Arguments (write {socket} where the program takes the path of its socket):';
export const READY_PATH_PROMPT = 'Path that answers when it is ready (for example /health):';
export const READY_PATH_PROBLEM = 'Write a path starting with /.';

export const programNamePrompt = (prefill: string | undefined): string => (prefill === undefined ? 'Name for this server:' : `Name for this server (Enter: ${prefill}):`);

export const allConfiguredText = (provider: string, address: string): string => `Every model that ${provider} at ${address} lists is in your settings already.`;

export const nameTakenText = (name: string): string => `${name} is already used by another server.`;

export const MODEL_ACTIONS = ['Edit', 'Remove'] as const;
export const SERVER_ACTIONS = ['Edit server', 'Name this server', 'Remove server'] as const;
export const FORGET_PROGRAM_TOO_ROW = 'Also forget the server program';
export const REMOVE_SERVER_ONLY_ROW = 'Remove the server';

export const HUB_ACTIONS = ['Add a model', 'Model for new sessions', 'Fallback models', 'Billing changes', 'Models for other roles', 'Wait limits', 'Programs', 'Check the servers'] as const;

export type HubAction = (typeof HUB_ACTIONS)[number];

export const START_TITLE = 'The model a new session starts with';
export const FIRST_MODEL_ROW = 'Use the first model in my settings';

export const FALLBACK_TITLE = 'If the model cannot answer, MomongaCode tries these in order';
export const FALLBACK_ADD_ROW = 'Add a model';
export const FALLBACK_ACTIONS = ['Remove', 'Move up', 'Move down'] as const;

export const billingQuestion = (from: string, to: string, server: string): string => `Requests that fall from ${from} to ${to} would be charged by ${server}. Allow this change?`;

export const billingScopeQuestion = (display: string): string => `Allow it for every model, or only for ${display}?`;

export const EVERY_MODEL_ROW = 'For every model';

export const onlyModelRow = (display: string): string => `Only for ${display}`;

export const BILLING_TITLE = 'Billing changes';
export const FORBID_ROW = 'Forbid';

export const ROLE_TITLE = 'Models for other roles';
export const SESSION_MODEL_ROW = "Use the session's model";

export const ROLE_ROWS = [
  { label: 'Summaries (compaction)', job: 'compaction' },
  { label: 'Reflection', job: 'reflection' },
  { label: 'Analysis', job: 'analysis' },
  { label: 'Auto-mode classifier', job: 'classifier' },
] as const;

export const TIMEOUTS_TITLE = 'Wait limits';

export const headersWaitRow = (shown: string): string => `Wait for the first reply: ${shown}`;

export const idleWaitRow = (shown: string): string => `Wait without any data: ${shown}`;

export const MINUTES_PROMPT = 'Minutes (a whole number, 1 or more):';
export const MINUTES_PROBLEM = 'Write a whole number of minutes, 1 or more.';

export const SERVER_NAME_PROMPT = 'Name (lower-case letters, digits, . _ - ; Enter to remove it):';

export const PROGRAMS_TITLE = 'Programs';
export const NO_PROGRAMS = 'No program is declared.';
export const PROGRAM_FIELD_ROWS = [
  { label: 'Command', field: 'command' },
  { label: 'Arguments', field: 'args' },
  { label: 'Ready path', field: 'readyPath' },
] as const;
export const FORGET_PROGRAM_ROW = 'Forget this program';

export const NOT_SET = 'not set';
export const CLEAR_ROW = 'Remove the value';

export const TOGGLE_ROWS = ['yes', 'no', 'not declared'] as const;

export const SIGN_IN_REQUIRED_WORD = 'sign in required';

export const MODEL_CHANGE_NOTE = 'a change applies from the next run';
export const ALSO_AT_START_LABEL = 'also use at every start';

export const startingModelSetText = (display: string): string => `Starting model set to ${display}`;

export { sessionModelNotConfiguredText as notConfiguredAnyMoreText } from '@momonga/protocol';

export const START_ONE_TEXT = 'Start one, or add it with /models add.';

export const configuredSwitchText = (display: string): string => `${display} is configured; /model switches to it`;

export const settingsFileLine = (file: string): string => `Settings file: ${file}`;
