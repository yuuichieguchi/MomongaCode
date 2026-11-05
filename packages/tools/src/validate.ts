import type { AnyTool } from './types.ts';
import { JsonDepthError, SchemaValidatorFailure, checkJsonDepth, compileUntrustedSchema, parseOutsideJson, sha256Hex, untrustedSchemaFailure, validateUntrusted } from '@momonga/foundation';
import type { UntrustedError } from '@momonga/foundation';

const MAX_REPORTED_ERRORS = 20;

export const schemaIdentity = (tool: { name: string; validatorIdentity?: string }): string => tool.validatorIdentity ?? tool.name;

export const TOOL_VALIDATOR_FAILED_CODE = 'tool_validator_failed';

export const toolRefusalKey = (tool: { name: string; validatorIdentity?: string }): string => sha256Hex(schemaIdentity(tool));

export const recordedFailureOf = (tool: AnyTool): string | undefined => {
  const identity = schemaIdentity(tool);
  const input = untrustedSchemaFailure(identity, tool.inputSchema);
  if (input !== undefined || tool.outputSchema === undefined) return input;
  return untrustedSchemaFailure(identity, tool.outputSchema);
};

const assertUsable = (tool: AnyTool): void => {
  const failure = recordedFailureOf(tool);
  if (failure !== undefined) throw new SchemaValidatorFailure(failure);
};

export const compileToolSchemas = (tool: AnyTool): void => {
  assertUsable(tool);
  if (tool.outputSchema !== undefined) compileUntrustedSchema(tool.outputSchema);
  compileUntrustedSchema(tool.inputSchema);
};

const unescapePointerSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');

const renderPath = (segments: readonly string[]): string => {
  if (segments.length === 0) return '(root)';
  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
};

const pathSegments = (instancePath: string): string[] =>
  instancePath === '' ? [] : instancePath.slice(1).split('/').map(unescapePointerSegment);

const describeError = (error: UntrustedError): string => {
  const segments = pathSegments(error.instancePath);
  switch (error.keyword) {
    case 'required':
      return `${renderPath([...segments, String(error.params['missingProperty'])])}: required property is missing`;
    case 'additionalProperties':
      return `${renderPath(segments)}: unknown property ${JSON.stringify(String(error.params['additionalProperty']))}`;
    case 'enum':
      return `${renderPath(segments)}: must be one of: ${(error.params['allowedValues'] as unknown[]).map(String).join(', ')}`;
    default:
      return `${renderPath(segments)}: ${error.message}`;
  }
};

const describeErrors = (toolName: string, errors: readonly UntrustedError[]): string => {
  const lines = errors.slice(0, MAX_REPORTED_ERRORS).map((error) => `- ${describeError(error)}`);
  if (errors.length > MAX_REPORTED_ERRORS) lines.push(`- … ${errors.length - MAX_REPORTED_ERRORS} more errors`);
  return [`Invalid input for ${toolName}:`, ...lines].join('\n');
};

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'validator-failed'; message: string; detail: string | undefined };

export const unavailable = (tool: AnyTool, detail: string | undefined): Extract<ValidationResult, { ok: false }> => ({
  ok: false,
  reason: 'validator-failed',
  message: `Tool ${tool.name} is unavailable for the rest of this run: its schema validator failed, so its input and output cannot be checked.`,
  detail,
});

const parseArguments = (tool: AnyTool, rawArguments: unknown): ValidationResult => {
  try {
    if (typeof rawArguments !== 'string') {
      checkJsonDepth(rawArguments);
      return { ok: true, value: rawArguments };
    }
    return { ok: true, value: parseOutsideJson(rawArguments) };
  } catch (error) {
    if (error instanceof JsonDepthError) return { ok: false, reason: 'invalid', message: `Invalid input for ${tool.name}: ${error.message}` };
    if (error instanceof SyntaxError) {
      return { ok: false, reason: 'invalid', message: `Invalid JSON arguments for ${tool.name}: ${error.message}\nReceived: ${String(rawArguments)}` };
    }
    throw error;
  }
};

export const validateToolInput = (tool: AnyTool, rawArguments: unknown): ValidationResult => {
  const parsed = parseArguments(tool, rawArguments);
  if (!parsed.ok) return parsed;
  try {
    const verdict = validateUntrusted(schemaIdentity(tool), tool.inputSchema, parsed.value);
    return verdict.valid ? parsed : { ok: false, reason: 'invalid', message: describeErrors(tool.name, verdict.errors) };
  } catch (error) {
    if (error instanceof SchemaValidatorFailure) return unavailable(tool, error.message);
    throw error;
  }
};
