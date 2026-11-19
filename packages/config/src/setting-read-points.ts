export const SETTING_READ_POINT_KINDS = ['operation', 'start', 'daemon-start'] as const;

export type SettingReadPoint = (typeof SETTING_READ_POINT_KINDS)[number];

export const SETTING_READ_POINTS: Readonly<Record<string, SettingReadPoint>> = {
  models: 'operation',
  'models.effort': 'start',
  autoMode: 'operation',
  pricing: 'operation',
  sandbox: 'operation',
  sandboxNetwork: 'operation',
  sandboxUnixSockets: 'operation',
  telemetry: 'operation',
  retention: 'operation',
  network: 'operation',
  env: 'operation',
  credentials: 'operation',
  permissions: 'operation',
  projectApprovals: 'operation',
  hooks: 'operation',
  verification: 'operation',
  projectChecks: 'operation',
  memory: 'operation',
  context: 'operation',
  tools: 'operation',
  mcp: 'operation',
  mcpServers: 'operation',
  enabledMcpjsonServers: 'operation',
  disabledMcpjsonServers: 'operation',
  enableAllProjectMcpServers: 'operation',
  limits: 'operation',
  ceilings: 'operation',
  mandates: 'operation',
  forges: 'operation',
  issues: 'operation',
  operations: 'operation',
  autoUpdates: 'operation',
  update: 'operation',
  daemon: 'daemon-start',
  gateway: 'operation',
  runtime: 'operation',
  'tui.theme': 'operation',
  'tui.screenReader': 'operation',
  'tui.reducedMotion': 'operation',
  'tui.notify': 'operation',
  'tui.screen': 'start',
  'tui.mouse': 'start',
  'tui.copyOnSelect': 'start',
  'tui.attachFileMentions': 'start',
};

export const settingReadPointOf = (key: string, table: Readonly<Record<string, SettingReadPoint>>): SettingReadPoint => {
  const parts = key.split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const found = table[parts.slice(0, length).join('.')];
    if (found !== undefined) return found;
  }
  throw new Error(`no reader of the setting ${key} is recorded in the table of read points`);
};
