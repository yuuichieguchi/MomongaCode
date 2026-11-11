import { ConfigError } from './config-error.ts';
import { MCP_EXPANSION_PATTERN } from './mcp-server-rules.ts';
import type { TelemetrySettings } from './settings.ts';

export type Expansion = { readonly variable: string; readonly fallback: string | undefined };

export type ExpansionHandlers = {
  readonly invalid: (body: string) => never;
  readonly resolve: (expansion: Expansion) => string;
};

const ESCAPED_OR_EXPANSION = new RegExp(`\\$?${MCP_EXPANSION_PATTERN.source}`, 'g');
const EXPANSION_BODY = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/;
const ESCAPE_MARK = '$$';

export const expandVariables = (value: string, handlers: ExpansionHandlers): string =>
  value.replace(ESCAPED_OR_EXPANSION, (match: string, body: string) => {
    if (match.startsWith(ESCAPE_MARK)) return match.slice(1);
    const parsed = EXPANSION_BODY.exec(body);
    if (parsed === null) return handlers.invalid(body);
    return handlers.resolve({ variable: parsed[1] as string, fallback: parsed[2] });
  });

type Environment = Readonly<Record<string, string | undefined>>;

export const environmentValueOf = (env: Environment, { variable, fallback }: Expansion): string | undefined => {
  const current = env[variable];
  if (current !== undefined && (current !== '' || fallback === undefined)) return current;
  return fallback;
};

const expandedHeader = (name: string, value: string, env: Environment): string => {
  const key = `telemetry.otlp.headers.${name}`;
  return expandVariables(value, {
    invalid: (body) => {
      throw new ConfigError(`${key} has an invalid expansion \${${body}}`);
    },
    resolve: (expansion) => {
      const expanded = environmentValueOf(env, expansion);
      if (expanded !== undefined) return expanded;
      throw new ConfigError(`${key} needs environment variable ${expansion.variable}, which is not set`);
    },
  });
};

export const telemetryWithReferences = (telemetry: TelemetrySettings | undefined, env: Environment): TelemetrySettings | undefined => {
  const headers = telemetry?.otlp?.headers;
  if (telemetry?.otlp === undefined || headers === undefined) return telemetry;
  const expanded = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, expandedHeader(name, value, env)]));
  return { ...telemetry, otlp: { ...telemetry.otlp, headers: expanded } };
};
