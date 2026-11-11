import { canonOf, messageOf } from '@momonga/protocol';

export const MODEL_NOT_LISTED_YET = 'not listed yet';

export type ManagedModelIds = { readonly declared?: string | undefined; readonly listed?: string | undefined };

export const managedModelName = (server: string, ids: ManagedModelIds): string => canonOf(server, ids.declared ?? ids.listed ?? MODEL_NOT_LISTED_YET);

export const aboutModel = (model: string, text: string): string => messageOf('aboutModel', 'gateway', { model, text });

export const managedConnectionPlace = (settingsFile: string, connections: readonly { readonly provider: string }[], server: string): string =>
  `${settingsFile}: models.connections[${connections.findIndex((connection) => connection.provider === server)}]`;
