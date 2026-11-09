export type McpTransportKind = 'stdio' | 'network';

export const MCP_TOOL_IDLE_TIMEOUT_MS: Readonly<Record<McpTransportKind, number>> = { network: 5 * 60 * 1000, stdio: 30 * 60 * 1000 };

export const MCP_TOOL_TOTAL_TIMEOUT_MS = 28 * 60 * 60 * 1000;

const UNITS: ReadonlyArray<readonly [ms: number, singular: string, plural: string]> = [
  [60 * 60 * 1000, 'hour', 'hours'],
  [60 * 1000, 'minute', 'minutes'],
  [1000, 'second', 'seconds'],
];

export const durationText = (ms: number): string => {
  for (const [unit, singular, plural] of UNITS) {
    if (ms >= unit && ms % unit === 0) {
      const count = ms / unit;
      return `${count} ${count === 1 ? singular : plural}`;
    }
  }
  return `${ms} ms`;
};
