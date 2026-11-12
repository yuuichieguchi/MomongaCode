export const BROWSER_ENV = 'BROWSER';
export const NO_COLOR_ENV = 'NO_COLOR';
export const NO_MOTION_ENV = 'NO_MOTION';
export const SCREEN_READER_ENV = 'MOMONGA_SCREEN_READER';
export const EDITOR_ENV_NAMES = ['VISUAL', 'EDITOR'] as const;
export const HOOK_FOLDER_ENV = 'MOMONGA_PROJECT_DIR';
export const LAYOUT_ENV_NAMES = ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA', 'APPDATA'] as const;
export const NETWORK_ENV_NAMES = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;
export const INSTALLER_ENV_NAMES = ['MOMONGA_REPO', 'MOMONGA_VERSION', 'MOMONGA_RELEASE_BASE_URL', 'MOMONGA_RELEASE_PUBLIC_KEY', 'MOMONGA_INSTALL_PREFIX', 'MOMONGA_MODIFY_PATH'] as const;

export const ENVIRONMENT_VARIABLE_KINDS = ['read', 'given', 'installer'] as const;

export type EnvironmentVariableKind = (typeof ENVIRONMENT_VARIABLE_KINDS)[number];

export type EnvironmentVariable = { readonly name: string; readonly kind: EnvironmentVariableKind; readonly meaning: string };

const NETWORK_MEANINGS: Readonly<Record<(typeof NETWORK_ENV_NAMES)[number], string>> = {
  https_proxy: 'the proxy of HTTPS requests to model servers and MCP servers, unless network.httpsProxy or network.httpProxy is set; ignored with network.environment false',
  HTTPS_PROXY: 'as https_proxy, read after it',
  http_proxy: 'the proxy of HTTP requests, and of HTTPS requests when no HTTPS proxy is set, unless network.httpProxy is set; ignored with network.environment false',
  HTTP_PROXY: 'as http_proxy, read after it',
  all_proxy: 'the proxy of every request when no other proxy variable is set; ignored with network.environment false',
  ALL_PROXY: 'as all_proxy, read after it',
  no_proxy: 'the hosts reached without the proxy, unless network.noProxy is set; ignored with network.environment false',
  NO_PROXY: 'as no_proxy, read after it',
  SSL_CERT_FILE: 'a file of certificate authorities trusted beside network.extraCaFiles; ignored with network.environment false',
  NODE_EXTRA_CA_CERTS: 'a file of certificate authorities that Node.js trusts beside its own',
};

const LAYOUT_MEANINGS: Readonly<Record<(typeof LAYOUT_ENV_NAMES)[number], string>> = {
  XDG_CACHE_HOME: 'Linux: the cache folder of momonga is momonga below it (default ~/.cache)',
  XDG_DATA_HOME: 'Linux: the keyrings folder below it holds the secrets of the account and is kept from every command (default ~/.local/share)',
  LOCALAPPDATA: 'Windows: the cache folder of momonga is momonga below it (default %USERPROFILE%\\AppData\\Local)',
  APPDATA: 'Windows: the Microsoft\\Credentials folder below it holds the secrets of the account and is kept from every command (default %USERPROFILE%\\AppData\\Roaming)',
};

const INSTALLER_MEANINGS: Readonly<Record<(typeof INSTALLER_ENV_NAMES)[number], string>> = {
  MOMONGA_REPO: '<owner>/<repo> of the GitHub repository to download from (default yuuichieguchi/MomongaCode); ignored when MOMONGA_RELEASE_BASE_URL is set',
  MOMONGA_VERSION: 'install this version (the v<version> release) instead of the latest; ignored when MOMONGA_RELEASE_BASE_URL is set',
  MOMONGA_RELEASE_BASE_URL: 'download from this address instead of GitHub; https, or http on the loopback interface only',
  MOMONGA_RELEASE_PUBLIC_KEY: 'the release signing key (an ssh-ed25519 line), used instead of the key in the installer',
  MOMONGA_INSTALL_PREFIX: 'where momonga is installed (default ~/.local on macOS and Linux, %LOCALAPPDATA%\\Programs\\momonga on Windows)',
  MOMONGA_MODIFY_PATH: '0 leaves PATH as it is',
};

export const ENVIRONMENT_VARIABLES: readonly EnvironmentVariable[] = [
  { name: SCREEN_READER_ENV, kind: 'read', meaning: '1 draws the interactive session as plain appended lines, as --screen-reader does, and turns motion off' },
  { name: NO_MOTION_ENV, kind: 'read', meaning: '1 turns the motion of the interactive session off' },
  { name: NO_COLOR_ENV, kind: 'read', meaning: 'any value but empty turns colour off' },
  { name: BROWSER_ENV, kind: 'read', meaning: 'the program that opens a sign-in page; without it xdg-open, open or rundll32 found on PATH' },
  ...EDITOR_ENV_NAMES.map((name) => ({ name, kind: 'read' as const, meaning: `the editor that opens the draft or a settings file${name === 'EDITOR' ? ', when VISUAL is not set' : ''}` })),
  ...NETWORK_ENV_NAMES.map((name) => ({ name, kind: 'read' as const, meaning: NETWORK_MEANINGS[name] })),
  ...LAYOUT_ENV_NAMES.map((name) => ({ name, kind: 'read' as const, meaning: LAYOUT_MEANINGS[name] })),
  { name: HOOK_FOLDER_ENV, kind: 'given', meaning: 'given to every hook command: the folder of the session' },
  ...INSTALLER_ENV_NAMES.map((name) => ({ name, kind: 'installer' as const, meaning: INSTALLER_MEANINGS[name] })),
];
