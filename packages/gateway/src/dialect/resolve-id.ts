import { DEFAULT_DIALECT_ID } from '@momonga/protocol';
import type { DialectId, EndpointProbeReport } from '@momonga/protocol';

export const resolveDialectId = (declared: DialectId | undefined, record: Pick<EndpointProbeReport, 'schemaDialect'> | null): DialectId =>
  declared ?? record?.schemaDialect.selected ?? DEFAULT_DIALECT_ID;
