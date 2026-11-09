import { afterEach, describe, it } from 'vitest';
import { CONTRACT_OPERATIONS, copyTemplate, openContractStore } from './contract-operations.ts';
import type { ContractStore } from './contract-operations.ts';

const template = process.env['MOMONGA_COMPAT_DB_TEMPLATE'];

const opened: Array<{ contract: ContractStore; remove(): void }> = [];

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.contract.close();
    entry.remove();
  }
});

describe.skipIf(template === undefined)('the contract of this release on a database a newer release migrated and wrote (H7, 11.7)', () => {
  it.each(CONTRACT_OPERATIONS.map((operation) => [operation.name, operation] as const))('%s', async (_name, operation) => {
    if (template === undefined) throw new Error('MOMONGA_COMPAT_DB_TEMPLATE is not set');
    const copy = copyTemplate(template);
    const contract = openContractStore(copy.dbPath);
    opened.push({ contract, remove: copy.remove });
    await operation.run(contract);
  });
});
