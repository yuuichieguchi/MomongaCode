import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageOf } from '@momonga/protocol';

const root = path.resolve(import.meta.dirname, '..');
const DESIGN_DOCUMENT_VARIABLE = 'MOMONGA_MANAGED_SERVERS_DESIGN_DOCUMENT';
const SHOWN_LENGTH = 104;
const socketPathTooLong = messageOf('serverSocketPathTooLong', 'gateway', { model: '<name>', byteLength: SHOWN_LENGTH, directory: '<directory>', code: '<code>' }).replace(`${SHOWN_LENGTH} bytes`, '<n> bytes');

describe('the managed server refuses a socket path that is too long with the one text of the vocabulary', () => {
  it('the managed server builds its refusal with the serverSocketPathTooLong message', () => {
    expect(fs.readFileSync(path.join(root, 'packages/gateway/src/managed/server.ts'), 'utf8')).toContain("messageOf('serverSocketPathTooLong', 'gateway'");
  });

  const document = process.env[DESIGN_DOCUMENT_VARIABLE];
  const title = `the managed-servers design named by ${DESIGN_DOCUMENT_VARIABLE} states that text and names its message`;
  if (document === undefined) {
    it.skip(title, () => undefined);
  } else {
    it(title, () => {
      const lines = fs.readFileSync(document, 'utf8').split('\n').filter((line) => line.includes(socketPathTooLong));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.filter((line) => !line.includes('`serverSocketPathTooLong`'))).toEqual([]);
    });
  }
});
