/* eslint-disable no-underscore-dangle */
const stream = require('stream');
const crypto = require('crypto');

const get = (store => self => (!store.has(self) ? store.set(self, {}) : null, store.get(self)))(new WeakMap());

class HashThrough extends stream.PassThrough {
  constructor(algorithm, options) {
    super();
    get(this).hasher = new crypto.Hash(algorithm, options);
  }

  _transform(v, e, c) {
    get(this).hasher.write(v);
    c(null, v);
  }

  _final(cb) {
    this.emit('digest', (get(this).digest = get(this).hasher.digest()));
    cb();
  }

  getHash() {
    return get(this).digest || null;
  }
}

module.exports = HashThrough;
