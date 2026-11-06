const test = require('node:test');
const assert = require('node:assert');
const { add, multiply } = require('../src/index.js');
test('adds', () => assert.strictEqual(add(2, 3), 5));
test('multiplies', () => assert.strictEqual(multiply(2, 3), 6));
