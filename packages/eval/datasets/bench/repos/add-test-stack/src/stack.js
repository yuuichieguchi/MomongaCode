class Stack {
  #items = [];

  push(item) {
    this.#items.push(item);
    return this;
  }

  pop() {
    if (this.#items.length === 0) throw new RangeError('stack is empty');
    return this.#items.pop();
  }

  peek() {
    if (this.#items.length === 0) throw new RangeError('stack is empty');
    return this.#items[this.#items.length - 1];
  }

  get size() {
    return this.#items.length;
  }
}

module.exports = { Stack };
