const test = require('node:test');
const assert = require('node:assert');
const { dedupe } = require('../src/dedupe.js');
test('keeps the first occurrences in order', () => assert.deepStrictEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2]));
test('accepts a key function', () => assert.deepStrictEqual(dedupe([{ id: 1, v: 'a' }, { id: 1, v: 'b' }], (item) => item.id), [{ id: 1, v: 'a' }]));
