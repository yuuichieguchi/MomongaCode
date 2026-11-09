import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeStoreDir } from '../helpers.ts';
import { CONTRACT_OPERATIONS, buildCompatTemplate, copyTemplate, openContractStore } from './contract-operations.ts';
import type { ContractStore } from './contract-operations.ts';

const opened: Array<{ contract: ContractStore; remove(): void }> = [];

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.contract.close();
    entry.remove();
  }
});

const openedCopy = async (): Promise<ContractStore> => {
  const template = path.join(makeStoreDir(), 'template.db');
  await buildCompatTemplate(template, 'self');
  const copy = copyTemplate(template);
  const contract = openContractStore(copy.dbPath);
  opened.push({ contract, remove: copy.remove });
  return contract;
};

describe('the contract suite against a template this build writes', () => {
  it('reads the rows the contract writer wrote', async () => {
    expect((await openedCopy()).store.listSessions()).toHaveLength(1);
  });

  it.each(CONTRACT_OPERATIONS.map((operation) => [operation.name, operation] as const))('%s', async (_name, operation) => {
    await operation.run(await openedCopy());
  });
});
