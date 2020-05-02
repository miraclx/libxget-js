/* eslint-disable no-underscore-dangle */
/* eslint-disable max-classes-per-file */
const crypto = require('crypto');
const stream = require('stream');

const axios = require('axios').default;
const merge2 = require('merge2');
const httpRange = require('http-range');
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

function buildChunks(url, spec, opts, {retries, start}) {
  const chunkAxiosInstance = axios.create({responseType: 'stream', ...opts});
  chunkAxiosInstance.interceptors.response.use(({data}) => data);
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
              chunkAxiosInstance.get(url, {
                headers: {Range: `bytes=${min + bytesRead}-${Number.isFinite(max) ? max : ''}`},
              }),
            {
              retries,
              destroyer: source => source.destroy(),
            },
          ),
        },
      ])
    ),
    [],
  );
}

async function getContentStruct(url) {
  const axiosInstance = axios.create();
  const extractData = ({headers, status, statusText}) => ({headers, status, statusText});
  const headData = extractData(await axiosInstance.head(url));
  if (headData.headers['content-length']) return headData;
  const getData = extractData(await axiosInstance.get(url, {headers: {Range: 'bytes=0-0'}}));
  if (
    getData.status === 416 || // Requested range not satisfiable
    getData.headers['content-length'] !== '1'
  )
    headData.unHEADRangeable = true;
  if ('content-range' in getData.headers)
    headData.headers['content-length'] = httpRange.ContentRange.prototype.parse(getData.headers['content-range']).length;
  else headData.headers['content-length'] = Infinity;
  return headData;
}

async function xHeadData(store, opts) {
  const {headers, status, statusText, unHEADRangeable} = await getContentStruct(store.url);
  if (!checkIsValidStatusCode(status)) return Promise.reject(new XgetNetException(status, statusText));
  if (unHEADRangeable) store.start = 0;
  if (!Number.isFinite(store.size))
    store.size = (headers['content-length'] ? parseFloat(headers['content-length']) : Infinity) - store.start;
  if (!unHEADRangeable && headers['accept-ranges'] === 'bytes' && Number.isFinite(store.size)) store.chunkable = true;
  else (store.chunks = 1), (store.chunkable = false);
  const spec = parseSplitSpec(store.size, store.chunks);
  store.chunkStack = buildChunks(
    store.url,
    spec,
    {...opts, timeout: store.timeout},
    {start: store.start, retries: store.chunkable ? store.retries : 1},
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

function pipeAll({input, data, store}) {
  let caughtErr = false;
  const sxTream = Object.entries(store.pipeStack).reduce((xStream, [tag, fn], _, arr) => {
    let dest;
    try {
      dest = fn(data, store.stack);
      if (!(dest && [dest.on, dest.pipe].every(slot => typeof slot === 'function')))
        throw Error(`Function labelled [${tag}] should return a Duplex stream`);
      if (!dest._readableState) dest = dest.pipe(new stream.PassThrough({objectMode: true}));
    } catch (er) {
      const err = Object(er);
      err[this.constructor.errHandler] = {tag, source: 'xget:use'};
      xStream.destroy();
      err.stack = err.stack.replace(
        /(.+?:\s)[^]+?((\s*)\s{2}at)/m,
        `$1An error occurred while creating a duplex transformer from the use middleware tagged [${tag}] $3${err.message}$2`,
      );
      this.destroy(err);
      caughtErr = true;
      arr.splice(1);
    }
    return dest && xStream.pipe(dest.once('error', err => this.destroy(((err.tag = tag), err))));
  }, input);

  return !caughtErr && sxTream;
}

function handleChunk({data, index, store}) {
  const xStream = pipeAll.call(this, {
    input: data.stream
      .on(
        'response',
        ({statusCode, statusMessage}) =>
          checkIsValidStatusCode(statusCode) || data.stream.emit('error', new XgetNetException(statusCode, statusMessage)),
      )
      .on('retry', ({retryCount, maxRetries, bytesRead, lastErr}) =>
        this.emit('retry', {index, retryCount, maxRetries, bytesRead, totalBytes: data.size, lastErr, store: store.stack}),
      )
      .once('error', (data.errHandler = err => this.destroy(((err.index = index), err)))),
    data,
    store,
  });
  return xStream && xStream.pipe(store.cache.set(`0x${index}`));
}

function xonstructor(url, opts) {
  const store = {
    url,
    rQd: false,
    size: null,
    ended: false,
    start: 0,
    chunks: 5,
    loaded: false,
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

  function handleLoad() {
    let caughtErr = false;
    const streams = store.chunkStack.slice(0).map((data, index, arr) => {
      const ret = handleChunk.call(this, {data, index, store});
      if (!ret) {
        caughtErr = true;
        arr.splice(1);
      }
      return ret;
    });
    if (!caughtErr)
      store.core
        .add(...streams)
        .on('data', data => {
          store.bytesRead += data.length;
          if (store.hash.hasher) store.hash.hasher.update(data);
          if (!this.push(data)) store.core.pause();
        })
        .on('end', () => {
          if (store.hash.hasher) store.hash.data = store.hash.hasher.digest();
          store.ended = true;
          this.push(null);
        });
  }

  xHeadData(store, opts)
    .then(loadData => {
      store.loaded = true;
      this.emit('loaded', loadData);
      Object.entries(store.withStack).forEach(([tag, fn]) => {
        let data;
        try {
          data = fn(loadData);
        } catch (er) {
          const err = Object(er);
          err[this.constructor.errHandler] = {tag, source: 'xget:with'};
          throw err;
        }
        store.stack.set(tag, data);
      });
      this.emit('set', store.stack);
      if (store.rQd) handleLoad.call(this);
      else this.once('rQd', handleLoad.bind(this));
    })
    .catch(err => {
      err = Object(err);
      const handler = err[this.constructor.errHandler];
      if (err.stack)
        err.stack = err.stack.replace(
          /(.+?:\s)[^]+?((\s*)\s{2}at)/m,
          `$1An error occurred while ${
            handler && handler.source
              ? `processing the data through the with middleware tagged [${handler.tag}]`
              : `${store.loaded ? 'processing information from' : 'trying to get information for'} the URL`
          } $3${err.message}$2`,
        );
      this.emit('error', err);
    });

  Object.defineProperties(this, {
    ended: {get: () => store.ended},
    store: {get: () => store.stack},
    loaded: {get: () => store.loaded},
    bytesRead: {get: () => store.bytesRead},
  });

  this._read = () => {
    if (!store.rQd) {
      if (store.loaded) this.emit('rQd');
      store.rQd = true;
    } else store.core ? (!store.core._readableState.flowing ? store.core.resume() : null) : null;
  };
  this._destroy = (err, cb) => {
    const doDestroy = () => (
      store.chunkStack.forEach(data => {
        if (data.errHandler) data.stream.removeListener('error', data.errHandler).on('error', () => {});
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
  this.getErrContext = raw => ({raw, ...raw[this.constructor.errHandler]});
}

class XGETStream extends stream.Readable {
  static errHandler = Symbol('XgetErrHandle');

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
