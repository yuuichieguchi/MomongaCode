class Store {
  #data = new Map();

  set(key, value) {
    this.#data.set(key, value);
  }

  get(key, callback) {
    setImmediate(() => callback(null, this.#data.get(key)));
  }
}

module.exports = { Store };
