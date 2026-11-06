const test = require('node:test');
const assert = require('node:assert');
const { parseDuration } = require('../src/duration.js');
test('reads one unit', () => assert.strictEqual(parseDuration('90s'), 90000));
test('reads several units', () => assert.strictEqual(parseDuration('1h30m'), 5400000));
test('rejects text with no unit', () => assert.throws(() => parseDuration('soon'), /invalid duration/));
