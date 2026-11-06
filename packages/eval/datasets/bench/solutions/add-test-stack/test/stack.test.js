const test = require('node:test');
const assert = require('node:assert');
const { Stack } = require('../src/stack.js');
test('pops in last-in first-out order', () => { const stack = new Stack().push(1).push(2); assert.deepStrictEqual([stack.pop(), stack.pop()], [2, 1]); });
test('peek reads the top without removing it', () => { const stack = new Stack().push(1).push(2); assert.strictEqual(stack.peek(), 2); assert.strictEqual(stack.size, 2); });
test('size follows push and pop', () => { const stack = new Stack(); stack.push(1); assert.strictEqual(stack.size, 1); stack.pop(); assert.strictEqual(stack.size, 0); });
test('push returns the stack', () => { const stack = new Stack(); assert.strictEqual(stack.push(1), stack); });
test('pop on an empty stack throws', () => assert.throws(() => new Stack().pop(), RangeError));
test('peek on an empty stack throws', () => assert.throws(() => new Stack().peek(), RangeError));
