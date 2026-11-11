import { readFileSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { carriedStream } from '../../../src/acp/carried-input.ts';
import type { CarriedStream } from '../../../src/acp/carried-input.ts';
import { HANDOVER_FORMAT, encodeRecord, parseRecord } from '../../../src/handover/record.ts';
import { hostReplace, replaceProcess } from '../../../src/handover/replace-process.ts';
import { acpInputOf } from '../../../src/node-ports.ts';

const [role, recordFile] = process.argv.slice(2);
if (recordFile === undefined) throw new Error('the fixture needs its role and a record file');

const answer = async (carried: CarriedStream, by: string): Promise<void> => {
  const reader = carried.stream.readable.getReader();
  const writer = carried.stream.writable.getWriter();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    const message = next.value;
    if ('id' in message && 'method' in message) await writer.write({ jsonrpc: '2.0', id: message.id, result: { by } });
  }
};

const stdio = () => ({ input: acpInputOf(process.stdin), output: Writable.toWeb(process.stdout) });

if (role === 'new') {
  const parsed = parseRecord(readFileSync(recordFile, 'utf8'));
  if (parsed.kind !== 'record' || parsed.record.kind !== 'acp') throw new Error('the new process was handed no ACP record');
  await answer(carriedStream(stdio(), Buffer.from(parsed.record.input, 'base64')), 'new');
} else {
  const carried = carriedStream(stdio(), new Uint8Array());
  process.on('message', () => {
    carried.hold('handover');
    const encoded = encodeRecord({ format: HANDOVER_FORMAT, fromVersion: '1.0.0', toVersion: '1.0.1', session: 'acp-1', lastSeq: {}, kind: 'acp', initialize: null, sessions: [], input: Buffer.from(carried.pending()).toString('base64') }, process.pid);
    if (encoded.kind !== 'fits') throw new Error('the record does not fit');
    writeFileSync(recordFile, encoded.text);
    process.send?.('held');
    process.disconnect?.();
    void replaceProcess({ file: process.execPath, args: [process.argv[1] ?? '', 'new', recordFile], env: process.env }, { ...hostReplace, execve: undefined }, { release: () => undefined });
  });
  await answer(carried, 'old');
}
