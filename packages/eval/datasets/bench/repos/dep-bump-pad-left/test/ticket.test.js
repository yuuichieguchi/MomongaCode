const test = require('node:test');
const assert = require('node:assert');
const { ticketNumber } = require('../src/ticket.js');
test('pads a string', () => assert.strictEqual(ticketNumber('42'), '000042'));
