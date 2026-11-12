export { MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS } from '@momonga/foundation';

export type McpTransportKind = 'stdio' | 'network';

export const MCP_IDLE_SETTING_KEYS: Readonly<Record<McpTransportKind, string>> = { network: 'mcp.toolIdleTimeoutNetworkMs', stdio: 'mcp.toolIdleTimeoutStdioMs' };

const UNITS: ReadonlyArray<readonly [ms: number, singular: string, plural: string]> = [
  [60 * 60 * 1000, 'hour', 'hours'],
  [60 * 1000, 'minute', 'minutes'],
  [1000, 'second', 'seconds'],
];

export const durationText = (ms: number): string => {
  if (ms % 1000 !== 0) return `${ms} ms`;
  const parts: string[] = [];
  let rest = ms;
  for (const [unit, singular, plural] of UNITS) {
    const count = Math.floor(rest / unit);
    rest -= count * unit;
    if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
  }
  return parts.length === 0 ? `${ms} ms` : parts.join(' ');
};
