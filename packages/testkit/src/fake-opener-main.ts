import { TEST_OPENER_RECORD_ENV, openerRecordIn, recordOpenerCall } from './opener-record.ts';

const [items, program, ...args] = process.argv.slice(2);
if (items === undefined || program === undefined) throw new Error('fake URL opener: the items directory and the program name are required');

const named = process.env[TEST_OPENER_RECORD_ENV];
recordOpenerCall(named === undefined || named === '' ? openerRecordIn(items) : named, { program, args });
