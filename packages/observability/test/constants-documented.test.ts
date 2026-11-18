import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { itWithDocuments } from '@momonga/testkit';
import { RUNTIME_TEARDOWN_BUDGET_MS } from '@momonga/foundation';
import { OTLP_EXPORTS_PER_TEARDOWN, OTLP_EXPORT_TIMEOUT_MS, OTLP_TEARDOWN_SHARE } from '@momonga/observability';
import { hasRow } from '../../../test/support/host-bounds-scan.ts';

const CONSTANTS_DOCUMENT_VARIABLE = 'MOMONGA_CONSTANTS_DOCUMENT';

const DOCUMENTED = {
  'gateway-config.md': ['OTLP_TEARDOWN_SHARE', 'OTLP_EXPORTS_PER_TEARDOWN', 'LEGACY_SPANS_PER_BATCH'],
  'runtime-store.md': ['MAX_TRACE_CONTENT_PAGE', 'COST_UNIT_DIGITS'],
} as const;

describe('the export bound of the trace exporter is derived from the teardown budget', () => {
  it('gives each export of a teardown its share of the share of the budget that exports may take', () => {
    expect(OTLP_EXPORT_TIMEOUT_MS).toBe((RUNTIME_TEARDOWN_BUDGET_MS * OTLP_TEARDOWN_SHARE) / OTLP_EXPORTS_PER_TEARDOWN);
  });
});

const documentTitle = `writes the derivation of every named constant of the trace and the cost report in the constants document named by ${CONSTANTS_DOCUMENT_VARIABLE}`;

describe('the constants of the observability package carry their derivation', () => {
  itWithDocuments(CONSTANTS_DOCUMENT_VARIABLE, import.meta.dirname, documentTitle, (constantsDocument) => {
    const missing = Object.entries(DOCUMENTED).flatMap(([file, names]) => names.filter((name) => !hasRow(fs.readFileSync(path.join(constantsDocument, file), 'utf8'), name)));
    expect(missing).toEqual([]);
  });
});
