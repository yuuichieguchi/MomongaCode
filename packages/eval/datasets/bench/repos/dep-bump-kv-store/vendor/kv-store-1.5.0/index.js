class Store {
  #data = new Map();

  set(key, value) {
    this.#data.set(key, value);
  }

  async read(key) {
    return this.#data.get(key);
  }
}

module.exports = { Store };
