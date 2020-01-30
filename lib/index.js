/* eslint-disable no-underscore-dangle */
/* eslint-disable max-classes-per-file */
const stream = require('stream');
const crypto = require('crypto');
const {promisify: pIfy} = require('util');

const merge2 = require('merge2');
const request = require('request');
const xresilient = require('xresilient');
const StreamCache = require('streaming-cache');

require('stream.pipeline-shim/auto');

const {XgetException, XgetNetException, XGET_CHECK_VAR} = require('./xgetception');

function parseSplitSpec(total, numberOfparts) {
  const chunkSize = Math.floor(total / numberOfparts);
  return {
    total,
    chunkSize,
    numberOfparts,
    lastChunkSize: numberOfparts !== 1 ? total - chunkSize * (numberOfparts - 1) : chunkSize,
  };
}

function checkIsValidStatusCode(statusCode) {
  return statusCode && typeof statusCode === 'number' && statusCode.toString()[0] === '2';
}

function buildChunks(spec, opts, {retries, start}) {
  return [...Array(spec.numberOfparts - 1).fill(spec.chunkSize), spec.lastChunkSize].reduce(
    (r, v, i, _, min, max) => (
      ((min = i === 0 ? start || 0 : r[i - 1].max + 1), (max = min + v - 1)),
      r.concat([
        {
          min,
          max,
          size: v,
          stream: xresilient(
            ({bytesRead}) =>
              request.get({...opts, headers: {Range: `bytes=${min + bytesRead}-${Number.isFinite(max) ? max : ''}`}}),
            {
              retries,
              destroyer: source => source.abort(),
            },
          ),
        },
      ])
    ),
    [],
  );
}

async function getContentStruct(url, timeout) {
  const extractData = ({headers, statusCode, statusMessage}) => ({headers, statusCode, statusMessage});
  const headData = extractData(await pIfy(request.head)(url, {timeout}));
  if (headData.headers['content-length']) return headData;
  const getData = extractData(
    await new Promise((res, rej) =>
      request
        .get(url, {timeout})
        .on('response', resp => (resp.req.abort(), res(resp)))
        .on('error', rej),
    ),
  );
  if (getData.headers['content-length']) headData.headers['content-length'] = getData.headers['content-length'];
  return headData;
}

async function xHeadData(store, opts) {
  const {headers, statusCode, statusMessage} = await getContentStruct(store.url, store.timeout);
  if (!checkIsValidStatusCode(statusCode)) return Promise.reject(new XgetNetException(statusCode, statusMessage));
  if (!Number.isFinite(store.size))
    store.size = (headers['content-length'] ? parseFloat(headers['content-length']) : Infinity) - store.start;
  if (headers['accept-ranges'] === 'bytes' && Number.isFinite(store.size)) store.chunkable = true;
  else (store.chunks = 1), (store.chunkable = false);
  const spec = parseSplitSpec(store.size, store.chunks);
  store.chunkStack = buildChunks(
    spec,
    {...opts, url: store.url, timeout: store.timeout},
    {start: store.start, retries: store.retries},
  );
  return {
    url: store.url,
    size: store.size,
    start: store.start,
    chunkable: store.chunkable,
    chunkStack: store.chunkStack,
    headers,
  };
}

function pipeAll({input, data, pipeStack, store}) {
  return Object.entries(pipeStack).reduce((xStream, [tag, fn]) => {
    let dest = fn(data, store);
    if (![dest.on, dest.pipe].every(slot => typeof slot === 'function'))
      throw Error(`Function labelled [${tag}] should return a Duplex stream`);
    if (!dest._readableState) dest = dest.pipe(new stream.PassThrough({objectMode: true}));
    return xStream.pipe(dest.once('error', err => this.destroy(((err.tag = tag), err))));
  }, input);
}

function handleChunk({data, index, store, pipeStack, cache}) {
  return pipeAll
    .call(this, {
      input: data.stream
        .on(
          'response',
          ({statusCode, statusMessage}) =>
            checkIsValidStatusCode(statusCode) || data.stream.emit('error', new XgetNetException(statusCode, statusMessage)),
        )
        .on('retry', ({retryCount, maxRetries, bytesRead, lastErr}) =>
          this.emit('retry', {index, retryCount, maxRetries, bytesRead, totalBytes: data.size, lastErr, store}),
        )
        .once('error', (data.errHandler = err => this.destroy(((err.index = index), err)))),
      data,
      pipeStack,
      store,
    })
    .pipe(cache.set(`0x${index}`));
}

function xonstructor(url, opts) {
  const store = {
    url,
    rQd: false,
    size: null,
    start: 0,
    ended: false,
    loaded: false,
    chunks: 5,
    retries: 5,
    timeout: null,
    bytesRead: 0,
    chunkable: true,
    pipeStack: {},
    withStack: {},
    core: merge2(),
    cache: new StreamCache(),
    stack: new Map(),
    hash: {algorithm: null, data: null, hasher: null},
  };
  if (XGET_CHECK_VAR(opts.size, 'opts.size', 'number', true)) (store.size = opts.size), delete opts.size;
  if (XGET_CHECK_VAR(opts.hash, 'opts.hash', 'string', true)) (store.hash.algorithm = opts.hash), delete opts.hash;
  if (XGET_CHECK_VAR(opts.use, 'opts.use', 'object', true)) (store.pipeStack = opts.use), delete opts.use;
  if (XGET_CHECK_VAR(opts.with, 'opts.with', 'object', true)) (store.withStack = opts.with), delete opts.with;
  if (XGET_CHECK_VAR(opts.start, 'opts.start', 'number', true)) (store.start = opts.start), delete opts.start;
  if (XGET_CHECK_VAR(opts.chunks, 'opts.chunks', 'number', true)) (store.chunks = opts.chunks), delete opts.chunks;
  if (XGET_CHECK_VAR(opts.retries, 'opts.retries', 'number', true)) (store.retries = opts.retries), delete opts.retries;
  if (XGET_CHECK_VAR(opts.timeout, 'opts.timeout', 'number', true)) (store.timeout = opts.timeout), delete opts.timeout;

  Object.entries(store.pipeStack).forEach(([key, value]) => XGET_CHECK_VAR(value, `opts.use[${key}]`, 'function'));
  Object.entries(store.withStack).forEach(([key, value]) => XGET_CHECK_VAR(value, `opts.with[${key}]`, 'function'));

  if (store.hash.algorithm) {
    if (!crypto.getHashes().includes(store.hash.algorithm)) throw new XgetException('opts.hash must be a valid hash algorithm');
    store.hash.hasher = new crypto.Hash(store.hash.algorithm);
  }

  function handleLoad(loadData) {
    Object.entries(store.withStack).forEach(([tag, fn]) => store.stack.set(tag, fn(loadData)));
    store.core
      .add(
        ...store.chunkStack.map((data, index) =>
          handleChunk.call(this, {
            data,
            index,
            cache: store.cache,
            store: store.stack,
            pipeStack: store.pipeStack,
          }),
        ),
      )
      .on('data', data => {
        // eslint-disable-next-line no-multi-assign
        this.bytesRead = store.bytesRead += data.length;
        if (store.hash.hasher) store.hash.hasher.update(data);
        if (!this.push(data)) store.core.pause();
      })
      .on('end', () => {
        if (store.hash.hasher) store.hash.data = store.hash.hasher.digest();
        // eslint-disable-next-line no-multi-assign
        this.ended = store.ended = true;
        this.push(null);
      });
  }

  xHeadData(store, opts)
    .then(loadData => {
      // eslint-disable-next-line no-multi-assign
      this.loaded = store.loaded = true;
      this.emit('loaded', loadData);
      if (store.rQd) handleLoad.call(this, loadData);
      else this.once('rQd', handleLoad.bind(this, loadData));
    })
    .catch(err => {
      err.stack = err.stack.replace(
        /(.+?:\s)[^]+?((\s*)\s{2}at)/m,
        `$1An error occurred while trying to get information for the URL$3${err.message}$2`,
      );
      this.emit('error', err);
    });

  this.bytesRead = 0;
  this.ended = false;
  this.loaded = false;
  this.store = store.stack;
  this._read = () => {
    if (!store.loaded) this.emit('rQd'), (store.rQd = true);
    else store.core ? (!store.core._readableState.flowing ? store.core.resume() : null) : null;
  };
  this._destroy = (err, cb) => {
    const doDestroy = () => (
      store.chunkStack.forEach(data => {
        data.stream.removeListener('error', data.errHandler);
        data.stream.destroy();
      }),
      cb(err)
    );
    if (store.loaded) doDestroy();
    else this.once('loaded', doDestroy);
  };
  this.getHash = (encoding = 'hex') => {
    let hash = null;
    if (store.hash.hasher) {
      hash = store.ended ? store.hash.data : store.hash.hasher.copy().digest();
      if (encoding) hash = hash.toString(encoding);
    }
    return hash;
  };
  this.getHashAlgorithm = () => store.hash.algorithm;
  this.use = (tag, fn) => {
    if (store.loaded) throw new XgetException('failed to attach use middleware: content loaded');
    XGET_CHECK_VAR(fn, 'fn', 'function');
    XGET_CHECK_VAR(tag, 'tag', 'string');
    store.pipeStack[tag] = fn;
    return this;
  };
  this.with = (tag, fn) => {
    if (store.loaded) throw new XgetException('failed to attach use middleware: content loaded');
    XGET_CHECK_VAR(fn, 'fn', 'function');
    XGET_CHECK_VAR(tag, 'tag', 'string');
    store.withStack[tag] = fn;
    return this;
  };
}

class XGETStream extends stream.Readable {
  constructor(url, opts) {
    super();
    xonstructor.call(this, url, opts);
  }
}

module.exports = function xget(url, opts) {
  const xtr = new XGETStream(url, opts);
  return xtr;
};

module.exports.XGETStream = XGETStream;
