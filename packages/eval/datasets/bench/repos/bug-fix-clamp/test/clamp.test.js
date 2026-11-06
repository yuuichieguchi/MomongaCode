const test = require('node:test');
const assert = require('node:assert');
const { clamp } = require('../src/clamp.js');
test('keeps a value inside the range', () => assert.strictEqual(clamp(5, 0, 10), 5));
test('raises a low value', () => assert.strictEqual(clamp(-1, 0, 10), 0));
test('rejects an inverted range', () => assert.throws(() => clamp(1, 10, 0), RangeError));
