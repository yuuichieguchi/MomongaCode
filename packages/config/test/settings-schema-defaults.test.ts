import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_NETWORK, MCP_CONNECT_TIMEOUT_LIMITS, MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS, SHUTDOWN_SETTING_LIMITS, STARTUP_TIMEOUT_MS } from '@momonga/foundation';
import { HOOK_DEFAULT_TIMEOUT_SECONDS } from '@momonga/protocol';
import {
  DEFAULT_RETENTION_DAYS,
  SETTINGS_SCHEMA,
  SETTING_DEFAULTS_BY,
  SETTING_UNIT_OF,
  defaultContextSettings,
  defaultMemorySettings,
  defaultToolsSettings,
  defaultVerificationSettings,
  DEFAULT_UPDATE_STALL_TIMEOUT_MS,
  FIVE_MINUTES_MS,
  defaultTuiSettings,
  resolveTelemetrySettings,
} from '@momonga/config';

type Node = Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

const propertyOf = (node: Node, step: string): unknown => {
  if (isNode(node['properties'])) return node['properties'][step];
  const branches = Array.isArray(node['oneOf']) ? node['oneOf'].filter(isNode) : [];
  const found = branches.map((branch) => (isNode(branch['properties']) ? branch['properties'][step] : undefined)).filter(isNode);
  return found.length === branches.length && found.length > 0 ? found[0] : undefined;
};

const nodeAt = (path: readonly string[]): Node => {
  let node: unknown = SETTINGS_SCHEMA;
  for (const step of path) {
    if (!isNode(node)) throw new Error(`no schema at ${path.join('.')}`);
    if (step === '[]') node = node['items'];
    else if (step === '<name>') node = node['additionalProperties'];
    else node = propertyOf(node, step);
  }
  if (!isNode(node)) throw new Error(`no schema at ${path.join('.')}`);
  return node;
};

const memory = defaultMemorySettings();
const verification = defaultVerificationSettings();
const context = defaultContextSettings();
const tools = defaultToolsSettings();

const DEFAULTS: readonly [string, unknown][] = [
  ['memory.reflection.enabled', memory.reflection.enabled],
  ['memory.forgetAfterDays', memory.forgetAfterDays],
  ['memory.repositoryFacts', memory.repositoryFacts],
  ['memory.autoReview', false],
  ['verification.manifests', verification.manifests],
  ['verification.required', verification.required],
  ...Object.entries(context).map(([key, value]): [string, unknown] => [`context.${key}`, value]),
  ['tools.deferral', tools.deferral],
  ['tools.conciseDescriptions', tools.conciseDescriptions],
  ['tools.ripgrep', tools.ripgrep],
  ...Object.entries(tools.bash).map(([key, value]): [string, unknown] => [`tools.bash.${key}`, value]),
  ['tools.search.timeoutMs', tools.search.timeoutMs],
  ['tools.operations.timeoutMs', tools.operations.timeoutMs],
  ['sandboxNetwork', DEFAULT_SANDBOX_NETWORK],
  ['permissions.defaultMode', 'manual'],
  ['autoUpdates', true],
  ['credentials.plaintextTokenFiles', false],
  ['enableAllProjectMcpServers', false],
  ['network.environment', true],
  ['telemetry.captureMessageContent', resolveTelemetrySettings(undefined).captureMessageContent],
  ['retention.days', DEFAULT_RETENTION_DAYS],
  ...Object.entries(defaultTuiSettings()).map(([key, value]): [string, unknown] => [`tui.${key}`, value]),
  ['update.stallTimeoutMs', DEFAULT_UPDATE_STALL_TIMEOUT_MS],
  ['daemon.startupStallMs', STARTUP_TIMEOUT_MS],
  ['models.headersTimeoutMs', FIVE_MINUTES_MS],
  ['models.idleTimeoutMs', FIVE_MINUTES_MS],
  ['mcp.toolIdleTimeoutNetworkMs', MCP_TOOL_IDLE_TIMEOUT_MS.network],
  ['mcp.toolIdleTimeoutStdioMs', MCP_TOOL_IDLE_TIMEOUT_MS.stdio],
  ['mcp.toolTotalTimeoutMs', MCP_TOOL_TOTAL_TIMEOUT_MS],
  ['mcp.closeGraceMs', SHUTDOWN_SETTING_LIMITS.mcpCloseGraceMs.default],
  ['mcp.connectTimeoutMs', MCP_CONNECT_TIMEOUT_LIMITS.default],
  ['gateway.closeGraceMs', SHUTDOWN_SETTING_LIMITS.closeGraceMs.default],
  ['gateway.managedServerStopGraceMs', SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.default],
  ['runtime.drainTimeoutMs', SHUTDOWN_SETTING_LIMITS.drainTimeoutMs.default],
  ['hooks.<name>.[].hooks.[].timeout', HOOK_DEFAULT_TIMEOUT_SECONDS.default],
];

const UNITS: readonly [string, string][] = [
  ['memory.forgetAfterDays', 'days'],
  ['retention.days', 'days'],
  ['tools.bash.defaultTimeoutMs', 'milliseconds'],
  ['tools.bash.maxTimeoutMs', 'milliseconds'],
  ['tools.bash.backgroundTimeoutMs', 'milliseconds'],
  ['tools.bash.maxBackgroundTimeoutMs', 'milliseconds'],
  ['tools.bash.drainIdleMs', 'milliseconds'],
  ['tools.search.timeoutMs', 'milliseconds'],
  ['tools.operations.timeoutMs', 'milliseconds'],
  ['update.stallTimeoutMs', 'milliseconds'],
  ['daemon.startupStallMs', 'milliseconds'],
  ['mcp.toolIdleTimeoutNetworkMs', 'milliseconds'],
  ['mcp.toolIdleTimeoutStdioMs', 'milliseconds'],
  ['mcp.toolTotalTimeoutMs', 'milliseconds'],
  ['mcp.closeGraceMs', 'milliseconds'],
  ['mcp.connectTimeoutMs', 'milliseconds'],
  ['models.headersTimeoutMs', 'milliseconds'],
  ['models.idleTimeoutMs', 'milliseconds'],
  ['gateway.closeGraceMs', 'milliseconds'],
  ['gateway.managedServerStopGraceMs', 'milliseconds'],
  ['runtime.drainTimeoutMs', 'milliseconds'],
  ['ceilings.timeMs', 'milliseconds'],
  ['mandates.<name>.timeMs', 'milliseconds'],
  ['mcpServers.<name>.timeoutMs', 'milliseconds'],
  ['mcpServers.<name>.idleTimeoutMs', 'milliseconds'],
  ['limits.maxCostUsd', 'USD'],
  ['ceilings.costUsd', 'USD'],
  ['mandates.<name>.costUsd', 'USD'],
  ['pricing.[].inputPerMTok', 'USD per million tokens'],
  ['pricing.[].cachedInputPerMTok', 'USD per million tokens'],
  ['pricing.[].cacheWritePerMTok', 'USD per million tokens'],
  ['pricing.[].outputPerMTok', 'USD per million tokens'],
  ['hooks.<name>.[].hooks.[].timeout', 'seconds'],
];

describe('the settings schema states the default the product takes and the unit of each value', () => {
  it.each(DEFAULTS)('%s states the default the product resolves', (key, expected) => {
    expect(nodeAt(key.split('.'))['default']).toEqual(expected);
  });

  it.each(UNITS)('%s has its unit %s beside the schema', (key, unit) => {
    expect(SETTING_UNIT_OF[key.replaceAll('.[]', '[]')]).toBe(unit);
  });

  it('every setting with a unit is one the schema declares, and the schema carries no unit keyword', () => {
    expect(Object.keys(SETTING_UNIT_OF).sort()).toEqual(UNITS.map(([key]) => key.replaceAll('.[]', '[]')).sort());
    for (const key of Object.keys(SETTING_UNIT_OF)) expect(Object.keys(nodeAt(key.replaceAll('[]', '.[]').split('.')))).not.toContain('unit');
  });

  it('the hook timeout has the default of every event that has its own, beside the schema', () => {
    const { default: _all, ...byEvent } = HOOK_DEFAULT_TIMEOUT_SECONDS;
    expect(SETTING_DEFAULTS_BY['hooks.<name>[].hooks[].timeout']).toEqual({ by: 'event', values: byEvent });
  });

  it('sandbox has the default of each OS mechanism, and none where the product has no mechanism, beside the schema', () => {
    expect(SETTING_DEFAULTS_BY['sandbox']).toEqual({ by: 'platform', values: { darwin: 'seatbelt', linux: 'bubblewrap', win32: 'none' } });
  });

  it('names only settings the schema declares, and the schema itself carries no keyword of its own for them', () => {
    for (const key of Object.keys(SETTING_DEFAULTS_BY)) {
      const node = nodeAt(key.replaceAll('[]', '.[]').split('.'));
      expect(Object.keys(node)).not.toContain('defaultsBy');
    }
  });
});
