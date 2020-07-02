/* eslint-disable max-classes-per-file */
const {Duplex} = require('stream');
const {totalmem} = require('os');

const LinkedList = require('linkedlist');

class CachingStream extends Duplex {
  #parent;

  /**
   * Construct a StreamingCache for efficient memory caching capability
   * @param {StreamCache} parent A parent streamcache instance to be bound to
   */
  constructor(parent) {
    super();
    // eslint-disable-next-line no-use-before-define
    if (!(parent && parent instanceof StreamCache)) throw new TypeError('<parent> must be an instance of a StreamCache');
    this.#parent = parent;
  }

  // eslint-disable-next-line no-underscore-dangle
  _write(chunk, _encoding, callback) {
    this.#parent.cacheBytesOn(this, chunk, callback);
  }

  // eslint-disable-next-line no-underscore-dangle
  _read() {
    this.#parent.readBytesOn(this);
  }

  // eslint-disable-next-line no-underscore-dangle
  _final(cb) {
    this.#parent.cacheBytesOn(this, null, cb);
  }
}

class StreamCache {
  #store = {
    items: new WeakMap(),
    length: 0,
    reallocate: false,
    allocBuffer: [],
    maxCapacity: 209715200,
    nowarn: false,
    meta: {
      max: 0,
      tickIndex: 0,
      totalComputed: 0,
    },
  };

  /**
   * Construct a managed StreamCache for efficient memory caching across variable streams
   * @param {{size: number; reallocate: boolean; nowarn: boolean;}} opts Options
   * @param [opts.size] Maximum shared buffer size **Default**: `209715200` (200 MiB)
   * @param [opts.reallocate] Whether or not to reallocate overflowing chunk slices **Default**: `false`
   * @param [opts.nowarn] Hide memory warning when cache capacity is more than 40% of total memory
   */
  constructor(opts) {
    opts = opts || {};
    if ('nowarn' in opts && opts.nowarn !== undefined)
      if (typeof opts.nowarn !== 'boolean') throw new TypeError('<opts.nowarn>, if defined must be a valid boolean');
      else this.#store.nowarn = opts.nowarn;
    if ('size' in opts && opts.size !== undefined)
      if (!Number.isSafeInteger(opts.size)) throw new TypeError('<opts.size>, if defined must be a valid number');
      else this.setCapacity(opts.size);
    if ('reallocate' in opts && opts.reallocate !== undefined)
      if (typeof opts.reallocate !== 'boolean') throw new TypeError('<opts.reallocate>, if defined must be a valid boolean');
      else this.#store.reallocate = opts.reallocate;
  }

  new() {
    const stream = new CachingStream(this);
    this.#store.items.set(stream, {buffer: new LinkedList(), pendingWrites: 0, pendingReads: 0});
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

  readBytesOn(stream) {
    const stack = this.#getStack(stream, err => stream.destroy(err));
    if (!stack) return;
    stack.pendingReads += 1;
    if (!this.#readOn(stream, stack)) this.dispatchAllocs();
  }

  #isFull = function isFull() {
    return this.#store.maxCapacity - this.#store.length <= 0;
  };

  dispatchAllocs() {
    // synchronously cycle through pending chunks
    // pop and cache chunks wherever possible
    let index = 0;
    while (index < this.#store.allocBuffer.length) {
      const value = this.#store.allocBuffer[index];
      if (!value) console.log(value, index);
      let [{chunk}, overflow] = [value, ,];
      const {stream, stack, callback} = value;
      if (this.#isFull()) {
        // if cache is full, try freeing some space by resolving pending readers
        if (
          // eslint-disable-next-line no-loop-func
          !this.#readOn(stream, stack, chunk, () => {
            // reason for this:
            //  • items are pending to be cached
            //  • can't cache because cache is full
            //  • can't read because buffer is empty
            // solution: push to the stream directly if there are readers available
            this.#store.allocBuffer.splice(index, 1);
            callback();
          })
        )
          index += 1; // move to next item if stack couldn't read chunks
      } else {
        const availableCapacity = this.#store.maxCapacity - this.#store.length;
        if (chunk) {
          if (chunk.length > availableCapacity)
            [chunk, overflow] = [chunk.slice(0, availableCapacity), chunk.slice(availableCapacity)];
          this.#store.length += chunk.length;
          if (this.#store.length > this.#store.meta.max) this.#store.meta.max = this.#store.length;
          this.averageMetaTick();
        }
        stack.buffer.push(chunk);
        const replacement = overflow && !this.#store.reallocate ? [{stream, stack, chunk: overflow, callback}] : [];
        const props = this.#store.allocBuffer.splice(index, 1, ...replacement);
        if (overflow && this.#store.reallocate) this.#store.allocBuffer.push({...props, chunk: overflow});
        if (!overflow) callback();
        else stack.pendingWrites += 1;
        if (stack.pendingReads) this.#readOn(stream, stack);
      }
    }
  }

  #allocOn = function allocOn(stream, stack, chunk, callback) {
    // || pending | reading ||=|| action ||
    // ||---------|---------||=||--------||
    // ||    true |       ~ ||=||  alloc ||
    // ||   false |    true ||=||   push ||
    // ||   false |   false ||=||  alloc ||
    // ||---------|---------||=||--------||

    // * pending : the stream has prior chunks waiting to be cached
    // * reading : the stream already has pending readers

    // * alloc   : wait for cache allocation before callback
    // * push    : bypass the cache and push directly into the stream
    // * shiftc  : bypass the cache and call the next reading handler

    // * pendingWrites : stream has unread chunks, pending or cached
    // * pendingReads  : stream has unresolved reads

    if (stack.pendingWrites || !stack.pendingReads) {
      stack.pendingWrites += 1;
      this.#store.allocBuffer.push({stream, stack, chunk, callback});
      this.dispatchAllocs();
    } else {
      // reason for this:
      //  • stream may have active readers whilst having no pending chunks
      //  • skip the hold-up of writing to the cache. fulfil immediately
      stream.push(chunk);
      stack.pendingReads -= 1;
      callback();
    }
  };

  #readOn = function readOn(stream, stack, altChunk, altHandler) {
    let chunk;
    let chunkHandler;
    if (stack.pendingReads && stack.buffer.length) {
      chunk = stack.buffer.shift();
      if (chunk) this.#store.length -= chunk.length;
      this.averageMetaTick();
    } else if (stack.pendingReads && (altChunk || altChunk === null)) {
      [chunk, chunkHandler] = [altChunk, altHandler];
    } else return false;
    stack.pendingReads -= 1;
    stack.pendingWrites -= 1;
    stream.push(chunk);
    if (typeof chunkHandler === 'function') chunkHandler();
    return true;
  };

  averageMetaTick() {
    this.#store.meta.totalComputed += this.#store.length;
    this.#store.meta.tickIndex += 1;
  }

  getSize() {
    return this.#store.length;
  }

  getCapacity() {
    return this.#store.maxCapacity;
  }

  setCapacity(capacity) {
    if (!Number.isSafeInteger(capacity)) throw new TypeError('<capacity> must be a valid number');
    const totalMem = totalmem();
    if (capacity > totalMem) throw new Error(`Capacity [${capacity}] is larger than total available memory [${totalMem}]`);
    if (!this.#store.nowarn && capacity > totalMem * 0.4)
      console.warn(`\x1b[33mWARN\x1b[0m: [StreamCache] Capacity is larger than 40% of available memory`);
    this.#store.maxCapacity = capacity;
  }

  getMeta() {
    this.averageMetaTick();
    return {
      max: this.#store.meta.max,
      average: this.#store.meta.totalComputed / this.#store.meta.tickIndex,
    };
  }
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

function test() {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  // eslint-disable-next-line global-require
  const path = require('path');
  // eslint-disable-next-line global-require
  const {Readable} = require('stream');

  // eslint-disable-next-line global-require
  const xbytes = require('xbytes');
  // eslint-disable-next-line global-require
  const ProgressBar = require('xprogress');

  let SIZE;
  const [TESTCODE, FILE, size] = process.argv.slice(2);

  if (['-h', '--help'].some(flag => process.argv.includes(flag))) {
    console.log('USAGE: streamCache.js <testCode> <inputFile> [cacheSize]');
    console.log('');
    console.log('  testCode');
    console.log('    1: copy inputFile directly using the stream cache');
    console.log('    2: copy inputFile twice one using cache, the other normally');
    console.log('    3: write zero bytes the size of inputFile from memory to *mask of inputFile');
    console.log('    4: write zero bytes the size of inputFile from /dev/zero to *mask of inputFile');
    console.log('');
    console.log('  masks');
    console.log('    inputFile: examplefile.txt');
    console.log('     test [1]: examplefile.test1.txt');
    console.log('     test [2]: examplefile.test2.1.txt, examplefile.test2.2.txt');
    console.log('     test [3]: examplefile.test3.txt');
    console.log('     test [4]: examplefile.test4.txt');
    console.log('');
    return;
  }

  if (!(TESTCODE && FILE)) {
    console.log('USAGE: streamCache.js <testCode> <inputFile> [cacheSize]');
    process.exit();
  }

  if (!['1', '2', '3', '4'].includes(TESTCODE)) throw new Error(`Invalid testCode [${TESTCODE}]. Expected: '1' or '2'`);
  if (!fs.existsSync(FILE)) throw new Error(`Input file <${FILE}> does not exist`);
  if (size && (SIZE = parseInt(size, 10)) && SIZE.toString() !== size)
    throw new Error(`Cache size, if provided must be a valid number `);

  const FILESIZE = fs.statSync(FILE).size;
  const {name: FILENAME, ext: EXT, dir: DIR} = path.parse(FILE);

  const CACHE = new StreamCache({size: SIZE || 419430400});

  function randomBytes(LENGTH, devZero) {
    if (!Number.isSafeInteger(LENGTH)) throw new Error('<size> is not a safe integer');
    return devZero
      ? fs.createReadStream('/dev/zero', {end: LENGTH - 1})
      : new Readable({
          read() {
            if ((this.cursor = this.cursor || 0) < LENGTH - 1) {
              const bytes = Math.min(this.readableHighWaterMark, LENGTH - this.cursor);
              this.cursor += bytes;
              this.push(Buffer.alloc(bytes));
            } else this.push(null);
          },
        });
  }

  function buildBarGen(LENGTH, ITEMS, initTime) {
    const barGen = ProgressBar.stream(LENGTH, ProgressBar.slotsByCount(ITEMS), {
      bar: {separator: '|'},
      template: [
        ':{label} {cache size: :{cacheSize}} {cache capacity: :{cacheCapacity}}',
        ' |:{bar:complete}| [:3{slot:percentage}%] (:{slot:eta}) [:{slot:speed(metric=/s)}] [:{slot:size}/:{slot:size:total}]',
        ' [:{bar}] [:3{percentage}%] (:{eta}) [:{speed(metric=/s)}] [:{size}/:{size:total}]',
      ],
      label: 'Writing...',
      variables: {
        cacheSize: () => CACHE.getSize(),
        cacheCapacity: () => CACHE.getCapacity(),
      },
    }).on('complete', () => {
      const meta = CACHE.getMeta();
      barGen.end(
        [
          '[+] Test Complete',
          ` \u2022 Runtime: ${(Date.now() - initTime) / 1000}s`,
          ` \u2022 Max Cache Size: (${meta.max}/${CACHE.getCapacity()}) (${xbytes(meta.max, {
            iec: true,
          })}/${xbytes(CACHE.getCapacity(), {iec: true})})`,
          ` \u2022 Average Cache Size: ${meta.average} (${xbytes(meta.average, {iec: true})})`,
          '',
        ].join('\n'),
      );
    });
    return barGen;
  }

  function test1() {
    const initTime = Date.now();
    const OUT = `${DIR}/${FILENAME}.test1${EXT}`;
    const barGen = buildBarGen(FILESIZE, 1, initTime);
    fs.createReadStream(FILE)
      .on('end', () => barGen.print(`1 [  cached]: ${(Date.now() - initTime) / 1000}s [${FILE} => ${OUT}]`))
      .pipe(CACHE.new())
      .pipe(barGen.next())
      .pipe(fs.createWriteStream(OUT));
  }

  function test2() {
    const initTime = Date.now();
    const OUT1 = `${DIR}/${FILENAME}.test2.1${EXT}`;
    const OUT2 = `${DIR}/${FILENAME}.test2.2${EXT}`;
    const ITEMS = 4;
    const barGen = buildBarGen(FILESIZE * ITEMS, ITEMS, initTime);

    const cacher1 = CACHE.new();
    // const cacher2 = CACHE.new();

    // process.on('exit', () => {
    //   console.log('');
    //   console.log('cache size:', cache.getSize());
    //   console.log('cache meta:', cache.getMeta());
    //   console.log('cache props:', cache.expose(cacher1));
    //   console.log('bargen average:', barGen.bar.average());
    // });

    const time1 = Date.now();
    fs.createReadStream(FILE)
      .on('end', () => barGen.print(`{ read} 1 [  cached]: ${(Date.now() - time1) / 1000}s [${FILE} => ${OUT1}]`))
      .pipe(barGen.next())
      .pipe(cacher1)
      .pipe(barGen.next())
      .on('finish', () => barGen.print(`{write} 1 [  cached]: ${(Date.now() - time1) / 1000}s [${FILE} => ${OUT1}]`))
      .pipe(fs.createWriteStream(OUT1));
    const time2 = Date.now();
    fs.createReadStream(FILE)
      .on('end', () => barGen.print(`{ read} 2 [uncached]: ${(Date.now() - time2) / 1000}s [${FILE} => ${OUT2}]`))
      .pipe(barGen.next())
      // .pipe(cacher2)
      .pipe(barGen.next())
      .on('finish', () => barGen.print(`{write} 2 [uncached]: ${(Date.now() - time2) / 1000}s [${FILE} => ${OUT2}]`))
      .pipe(fs.createWriteStream(OUT2));
  }

  function test3() {
    const initTime = Date.now();
    const OUT = `${DIR}/${FILENAME}.test1${EXT}`;
    const barGen = buildBarGen(FILESIZE, 1, initTime);
    randomBytes(FILESIZE)
      .on('end', () => barGen.print(`1 [  cached]: ${(Date.now() - initTime) / 1000}s [memory => ${OUT}]`))
      .pipe(CACHE.new())
      .pipe(barGen.next())
      .pipe(fs.createWriteStream(OUT));
  }

  function test4() {
    const initTime = Date.now();
    const OUT = `${DIR}/${FILENAME}.test1${EXT}`;
    const barGen = buildBarGen(FILESIZE, 1, initTime);
    randomBytes(FILESIZE, true)
      .on('end', () => barGen.print(`1 [  cached]: ${(Date.now() - initTime) / 1000}s [/dev/zero => ${OUT}]`))
      .pipe(CACHE.new())
      .pipe(barGen.next())
      .pipe(fs.createWriteStream(OUT));
  }

  switch (TESTCODE) {
    case '1':
      test1();
      break;
    case '2':
      test2();
      break;
    case '3':
      test3();
      break;
    case '4':
      test4();
      break;
    default:
      break;
  }
}

if (require.main === module) test();
