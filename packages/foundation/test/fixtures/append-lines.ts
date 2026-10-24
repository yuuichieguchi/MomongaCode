import { LOG_KEEP, LOG_MAX_BYTES, createRotatingLogFile } from '../../src/rotating-log.ts';

const [file, tag, countText] = process.argv.slice(2);
if (file === undefined || tag === undefined || countText === undefined) throw new Error('usage: append-lines.ts <file> <tag> <count>');
const sink = createRotatingLogFile({ path: file, maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP });
const pad = tag.repeat(1000);
for (let index = 0; index < Number.parseInt(countText, 10); index += 1) sink.write(JSON.stringify({ tag, index, pad }));
sink.close();
