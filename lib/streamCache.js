/* eslint-disable no-use-before-define, max-classes-per-file */
const {Duplex} = require('stream');
const xbytes = require('xbytes');

class CachingStream extends Duplex {
  #parent;

  /**
   * Construct a StreamingCache for efficient memory caching capability
   * @param {StreamCache} parent A parent streamcache instance to be bound to
   */
  constructor(parent) {
    super();
    if (!(parent && parent instanceof StreamCache)) throw new TypeError('<parent> must be an instance of a StreamCache');
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

  // eslint-disable-next-line no-underscore-dangle
  _final(cb) {
    this.push(null);
    cb();
  }
}

class StreamCache {
  #store = {
    items: new WeakMap(),
    length: 0,
    reallocate: false,
    allocBuffer: [],
    maxCapacity: 209715200,
    meta: {
      max: 0,
      tickIndex: 0,
      totalComputed: 0,
    },
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
      if (typeof opts.size !== 'number') throw new TypeError('<opts.size>, if defined must be a valid number');
      else this.#store.maxCapacity = opts.size;
    if ('reallocate' in opts && opts.reallocate !== undefined)
      if (typeof opts.reallocate !== 'boolean') throw new TypeError('<opts.reallocate>, if defined must be a valid boolean');
      else this.#store.reallocate = opts.reallocate;
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
        if (this.#store.length > this.#store.meta.max) this.#store.meta.max = this.#store.length;
        this.averageMetaTick();
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

  averageMetaTick() {
    this.#store.meta.totalComputed += this.#store.length;
    this.#store.meta.tickIndex += 1;
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

  setCapacity(capacity) {
    if (typeof capacity !== 'number') throw new TypeError('<capacity> must be a valid number');
    this.#store.maxCapacity = capacity;
  }

  getMeta() {
    this.averageMetaTick();
    return {
      max: this.#store.meta.max,
      average: this.#store.meta.totalComputed / this.#store.meta.tickIndex,
    };
  }

  readBytesOn(stream, callback) {
    const stack = this.#getStack(stream, callback);
    if (!stack) return;
    function processCache() {
      let chunk;
      if ((chunk = stack.shift())) {
        this.#store.length -= chunk.length;
        callback(null, chunk);
        this.averageMetaTick();
        this.dispatchAllocs();
      }
    }
    if (stack.length > 0) processCache.call(this);
    else stream.once('cached', processCache.bind(this));
  }
}

function test() {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  // eslint-disable-next-line global-require
  const path = require('path');
  // eslint-disable-next-line global-require
  const ProgressBar = require('xprogress');

  let SIZE;
  const [FILE, size] = process.argv.slice(2);

  if (!FILE) {
    console.log('USAGE: streamCache.js <inputFile> [cacheSize]');
    process.exit();
  }

  if (!fs.existsSync(FILE)) throw new Error(`Input file <${FILE}> does not exist`);
  if (size && (SIZE = parseInt(size, 10)) && SIZE.toString() !== size)
    throw new Error(`Cache size, if provided must be a valid number `);

  const {name: filename, ext, dir} = path.parse(FILE);
  const OUT1 = `${dir}/${filename}.test1${ext}`;
  const OUT2 = `${dir}/${filename}.test2${ext}`;
  const OUT3 = `${dir}/${filename}.test3${ext}`;
  const OUT4 = `${dir}/${filename}.test4${ext}`;

  const initTime = Date.now();
  const cache = new StreamCache({size: SIZE || 419430400});

  const barGen = ProgressBar.stream(fs.statSync(FILE).size * 4, ProgressBar.slotsByCount(4), {
    bar: {separator: '|'},
    template: [
      ':{label} {cache size: :{cacheSize}} {cache capacity: :{cacheCapacity}}',
      ' |:{bar:complete}| [:3{slot:percentage}%] (:{slot:eta}) [:{slot:speed(iec=true,bits=false,metric=/s)}] [:{slot:size}/:{slot:size:total}]',
      ' [:{bar}] [:3{percentage}%] (:{eta}) [:{speed(iec=true,bits=false,metric=/s)}] [:{size}/:{size:total}]',
    ],
    label: 'Writing...',
    variables: {
      cacheSize: () => cache.getSize(),
      cacheCapacity: () => cache.getCapacity(),
    },
  }).on('complete', () => {
    const meta = cache.getMeta();
    barGen.end(
      [
        '[+] Test Complete',
        ` \u2022 Runtime: ${(Date.now() - initTime) / 1000}s`,
        ` \u2022 Max Cache Size: (${meta.max}/${cache.getCapacity()}) (${xbytes(meta.max, {
          iec: true,
        })}/${xbytes(cache.getCapacity(), {iec: true})})`,
        ` \u2022 Average Cache Size: ${meta.average} (${xbytes(meta.average, {iec: true})})`,
        '',
      ].join('\n'),
    );
  });

  const time1 = Date.now();
  fs.createReadStream(FILE)
    .on('end', () => barGen.print(`1 [  cached]: ${(Date.now() - time1) / 1000}s [${FILE} => ${OUT1}]`))
    .pipe(barGen.next())
    .pipe(cache.new())
    .pipe(fs.createWriteStream(OUT1));
  const time2 = Date.now();
  fs.createReadStream(FILE)
    .on('end', () => barGen.print(`2 [uncached]: ${(Date.now() - time2) / 1000}s [${FILE} => ${OUT2}]`))
    .pipe(barGen.next())
    .pipe(fs.createWriteStream(OUT2));
  const time3 = Date.now();
  fs.createReadStream(FILE)
    .on('end', () => barGen.print(`3 [  cached]: ${(Date.now() - time3) / 1000}s [${FILE} => ${OUT3}]`))
    .pipe(barGen.next())
    .pipe(cache.new())
    .pipe(fs.createWriteStream(OUT3));
  const time4 = Date.now();
  fs.createReadStream(FILE)
    .on('end', () => barGen.print(`4 [uncached]: ${(Date.now() - time4) / 1000}s [${FILE} => ${OUT4}]`))
    .pipe(barGen.next())
    .pipe(fs.createWriteStream(OUT4));
}

module.exports = StreamCache;
module.exports.CachingStream = CachingStream;
module.exports.generator = function buildSingleStreamCache(size) {
  // you lose control with this option.
  // cannot change capacity, get metrics or add new children.
  if (size && typeof size !== 'number') throw new TypeError('<size>, if defined must be a valid number');
  const parent = new StreamCache({size});
  return parent.new();
};

if (require.main === module) test();
