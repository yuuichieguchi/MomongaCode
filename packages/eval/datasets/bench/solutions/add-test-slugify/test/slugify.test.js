const test = require('node:test');
const assert = require('node:assert');
const { slugify } = require('../src/slugify.js');
test('lower-cases', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));
test('collapses separators', () => assert.strictEqual(slugify('a   b'), 'a-b'));
test('trims edge dashes', () => assert.strictEqual(slugify('--a--b--'), 'a-b'));
test('keeps digits', () => assert.strictEqual(slugify('route 66'), 'route-66'));
