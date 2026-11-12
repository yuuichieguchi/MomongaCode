import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_NETWORK, MCP_CONNECT_TIMEOUT_LIMITS, MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS, SHUTDOWN_SETTING_LIMITS } from '@momonga/foundation';
import { HOOK_DEFAULT_TIMEOUT_SECONDS } from '@momonga/protocol';
import {
  DEFAULT_RETENTION_DAYS,
  SETTINGS_SCHEMA,
  defaultContextSettings,
  defaultMemorySettings,
  defaultSandboxSetting,
  defaultToolsSettings,
  defaultVerificationSettings,
  DEFAULT_UPDATE_STALL_TIMEOUT_MS,
  FIVE_MINUTES_MS,
  defaultTuiSettings,
} from '@momonga/config';

type Node = Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

const nodeAt = (path: readonly string[]): Node => {
  let node: unknown = SETTINGS_SCHEMA;
  for (const step of path) {
    if (!isNode(node)) throw new Error(`no schema at ${path.join('.')}`);
    if (step === '[]') node = node['items'];
    else if (step === '<name>') node = node['additionalProperties'];
    else node = isNode(node['properties']) ? node['properties'][step] : undefined;
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
  ['verification.commands', verification.commands],
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
  ['retention.days', DEFAULT_RETENTION_DAYS],
  ...Object.entries(defaultTuiSettings()).map(([key, value]): [string, unknown] => [`tui.${key}`, value]),
  ['update.stallTimeoutMs', DEFAULT_UPDATE_STALL_TIMEOUT_MS],
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
  ['tools.search.timeoutMs', 'milliseconds'],
  ['tools.operations.timeoutMs', 'milliseconds'],
  ['update.stallTimeoutMs', 'milliseconds'],
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

  it.each(UNITS)('%s states its unit %s', (key, unit) => {
    expect(nodeAt(key.split('.'))['unit']).toBe(unit);
  });

  it('the hook timeout states the default of every event that has its own', () => {
    const { default: _all, ...byEvent } = HOOK_DEFAULT_TIMEOUT_SECONDS;
    expect(nodeAt(['hooks', '<name>', '[]', 'hooks', '[]', 'timeout'])['defaultsBy']).toEqual({ by: 'event', values: byEvent });
  });

  it('sandbox states the default of each platform the product chooses', () => {
    const platforms = ['darwin', 'linux', 'win32'] as const;
    expect(nodeAt(['sandbox'])['defaultsBy']).toEqual({ by: 'platform', values: Object.fromEntries(platforms.map((platform) => [platform, defaultSandboxSetting(platform)])) });
  });
});
