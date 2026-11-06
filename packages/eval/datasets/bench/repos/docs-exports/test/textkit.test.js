const test = require('node:test');
const assert = require('node:assert');
const { upper } = require('../src/index.js');
test('upper', () => assert.strictEqual(upper('a'), 'A'));
