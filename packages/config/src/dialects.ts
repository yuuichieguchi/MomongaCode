import { BUILTIN_DIALECT_IDS, DIALECT_ID_PATTERN } from '@momonga/protocol';
import type { DialectDefinition } from '@momonga/protocol';
import { ConfigError } from './config-error.ts';
import type { ModelConnection } from './settings.ts';

const ID_PATTERN = new RegExp(DIALECT_ID_PATTERN);

const isBuiltin = (id: string): boolean => (BUILTIN_DIALECT_IDS as readonly string[]).includes(id);

export const resolveDialects = (declared: Record<string, DialectDefinition> | undefined, source: string): Record<string, DialectDefinition> => {
  const dialects: Record<string, DialectDefinition> = {};
  for (const [id, definition] of Object.entries(declared ?? {})) {
    const where = `${source}: models.dialects.${id}`;
    if (!ID_PATTERN.test(id)) throw new ConfigError(`${where}: the dialect id ${JSON.stringify(id)} must match ${DIALECT_ID_PATTERN}`);
    if (isBuiltin(id)) throw new ConfigError(`${where}: ${JSON.stringify(id)} is the id of a built-in dialect and cannot be redefined`);
    if (definition.extends !== undefined && !isBuiltin(definition.extends)) {
      throw new ConfigError(`${where}: extends ${JSON.stringify(definition.extends)}, which is not a built-in dialect (${BUILTIN_DIALECT_IDS.join(', ')})`);
    }
    dialects[id] = definition;
  }
  return dialects;
};

export const checkModelDialects = (connections: readonly ModelConnection[], dialects: Record<string, DialectDefinition>, source: string): void => {
  connections.forEach((connection, index) => {
    (connection.models ?? []).forEach((entry, entryIndex) => {
      const id = entry.capabilities !== undefined && 'schemaDialect' in entry.capabilities ? entry.capabilities.schemaDialect : undefined;
      if (id === undefined || isBuiltin(id) || Object.hasOwn(dialects, id)) return;
      throw new ConfigError(`${source}: models.connections[${index}].models[${entryIndex}]: capabilities.schemaDialect ${JSON.stringify(id)} is neither a built-in dialect nor declared in models.dialects`);
    });
  });
};
