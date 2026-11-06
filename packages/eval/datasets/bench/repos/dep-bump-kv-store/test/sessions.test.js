const test = require('node:test');
const assert = require('node:assert');
const { save, load } = require('../src/session.js');
const { hit } = require('../src/counter.js');
test('loads a saved session', (t, done) => { save('a', { user: 'ada' }); load('a', (error, session) => { assert.ifError(error); assert.deepStrictEqual(session, { user: 'ada' }); done(); }); });
test('counts hits', (t, done) => { hit('k', () => hit('k', (error, count) => { assert.ifError(error); assert.strictEqual(count, 2); done(); })); });
