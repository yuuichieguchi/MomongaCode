const test = require('node:test');
const assert = require('node:assert');
const { truncate } = require('../src/truncate.js');
test('short text is kept', () => assert.strictEqual(truncate('abc'), 'abc'));
