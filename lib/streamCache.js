/* eslint-disable no-use-before-define, max-classes-per-file */
const {Duplex} = require('stream');

class CachingStream extends Duplex {
  #parent;

  /**
   * Construct a StreamingCache for efficient memory caching capability
   * @param {StreamCache} parent A parent streamcache instance to be bound to
   */
  constructor(parent) {
    super();
    if (!(parent && parent instanceof StreamCache)) throw new Error('<parent> must be an instance of a StreamCache');
    this.#parent = parent;
  }

  // eslint-disable-next-line no-underscore-dangle
  _write(chunk, encoding, callback) {
    this.#parent.cacheBytesOn(this, chunk, callback);
  }

  // eslint-disable-next-line no-underscore-dangle
  _read() {
    this.#parent.readBytesOn(this, (err, chunk) => (err ? this.destroy(err) : this.push(chunk)));
  }
}

class StreamCache {
  #store = {
    items: new WeakMap(),
    length: 0,
    reallocate: false,
    allocBuffer: [],
    maxCapacity: 209715200,
  };

  /**
   * Construct a managed StreamCache for efficient memory caching across variable streams
   * @param {{size: number; reallocate: boolean;}} opts Options
   * @param [opts.size] Maximum shared buffer size **Default**: `209715200` (200 MiB)
   * @param [opts.reallocate] Whether or not to reallocate overflowing chunk slices **Default**: `false`
   */
  constructor(opts) {
    opts = opts || {};
    if ('size' in opts && opts.size !== undefined)
      if (typeof opts.size !== 'number') throw new Error('<opts.size>, if defined must be a valid number');
      else this.#store.maxCapacity = opts.size;
    if ('reallocate' in opts && opts.size !== undefined)
      if (typeof opts.reallocate !== 'boolean') throw new Error('<opts.reallocate>, if defined must be a valid boolean');
      else this.#store.reallocate = opts.speed;
  }

  new() {
    const stream = new CachingStream(this);
    this.#store.items.set(stream, []);
    return stream;
  }

  #getStack = function getStack(stream, callback) {
    const stack = this.#store.items.get(stream);
    if (!stack) {
      callback(new Error('<stream> input is not a valid child of the StreamCache'));
      return false;
    }
    return stack;
  };

  cacheBytesOn(stream, chunk, callback) {
    const stack = this.#getStack(stream, callback);
    if (!stack) return;
    this.#allocOn(stream, stack, chunk, callback);
  }

  dispatchAllocs() {
    queueMicrotask(() => {
      this.#store.allocBuffer.forEach(({stream, stack, chunk, callback}, index) => {
        const availableCapacity = this.#store.maxCapacity - this.#store.length;
        if (availableCapacity <= 0) return;
        let overflow;
        if (chunk.length > availableCapacity)
          [chunk, overflow] = [chunk.slice(0, availableCapacity), chunk.slice(availableCapacity)];
        this.#store.length += chunk.length;
        stack.push(chunk);
        stream.emit('cached');
        if (this.#store.reallocate) {
          this.#store.allocBuffer.splice(index, 1);
          if (!overflow) callback();
          else this.#allocOn(stream, stack, overflow, callback);
        } else {
          this.#store.allocBuffer.splice(index, 1, ...(overflow ? [{stream, stack, chunk: overflow, callback}] : []));
          if (!overflow) callback();
        }
      });
    });
  }

  #allocOn = function allocOn(stream, stack, chunk, callback) {
    this.#store.allocBuffer.push({stream, stack, chunk, callback});
    this.dispatchAllocs();
  };

  getSize() {
    return this.#store.length;
  }

  getCapacity() {
    return this.#store.maxCapacity;
  }

  readBytesOn(stream, callback) {
    const stack = this.#getStack(stream, callback);
    if (!stack) return;
    function processCache() {
      let chunk;
      if ((chunk = stack.shift())) {
        this.#store.length -= chunk.length;
        callback(null, chunk);
        this.dispatchAllocs();
      }
    }
    if (stack.length > 0) processCache.call(this);
    else stream.once('cached', processCache.bind(this));
  }
}

module.exports = function buildSingleStreamCache(size) {
  const parent = new StreamCache({size});
  return parent.new();
};

module.exports.StreamCache = StreamCache;
module.exports.CachingStream = CachingStream;

if (require.main === module) test();
