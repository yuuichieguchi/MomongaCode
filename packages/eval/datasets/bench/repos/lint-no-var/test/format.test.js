const test = require('node:test');
const assert = require('node:assert');
const { label } = require('../src/format.js');
test('singular', () => assert.strictEqual(label('file', 1), 'file'));
test('plural', () => assert.strictEqual(label('file', 2), 'files'));
