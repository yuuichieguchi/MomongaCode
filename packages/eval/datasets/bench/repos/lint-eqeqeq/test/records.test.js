const test = require('node:test');
const assert = require('node:assert');
const { sameId, differs } = require('../src/match.js');
const { countBy } = require('../src/count.js');
test('sameId', () => assert.strictEqual(sameId({ id: 1 }, { id: 1 }), true));
test('differs', () => assert.strictEqual(differs({ name: 'a' }, { name: 'b' }), true));
test('countBy', () => assert.deepStrictEqual(countBy(['a', 'b', 'a'], (x) => x), { a: 2, b: 1 }));
