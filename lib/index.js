import crypto from 'crypto';
import stream from 'stream';

import axios from 'axios';
import merge2 from 'merge2';
import httpRange from 'http-range';
import xresilient from 'xresilient';

import StreamCache from './streamCache.js';
import {XgetException, XgetNetException, XGET_CHECK_VAR} from './xgetception.js';

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
  chunkAxiosInstance.interceptors.response.use(({data}) =>
    data.on('aborted', () => data.emit('error', new Error(`pipe terminated abruptly`))),
  );
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

async function getContentStruct(store) {
  const axiosInstance = axios.create({responseType: 'stream'});
  let retryCount = 0;
  axiosInstance.interceptors.response.use(
    props => (props.data.destroy(), props),
    error =>
      retryCount < store.retries && !(error.response && error.response.status === 403)
        ? (this.emit('retry', {
            meta: true,
            retryCount: (retryCount += 1),
            maxRetries: store.retries,
            lastErr: error,
            store: store.stack,
          }),
          axiosInstance.request(error.config))
        : Promise.reject(error),
  );
  const extractData = ({headers, status, statusText}) => ({headers, status, statusText});
  const getData = extractData(await axiosInstance.get(store.url, {headers: {Range: 'bytes=0-'}}));
  if (getData.status === 416) getData.unHEADRangeable = true; // Requested range not satisfiable
  if (!getData.headers['content-length'])
    if ('content-range' in getData.headers) {
      getData.headers['content-length'] = httpRange.ContentRange.prototype.parse(getData.headers['content-range']).length;
      getData.unHEADRangeable = false;
    } else getData.headers['content-length'] = Infinity;
  return getData;
}

async function xHeadData(store, opts) {
  const {headers, status, statusText, unHEADRangeable} = await getContentStruct.call(this, store);
  if (!checkIsValidStatusCode(status)) return Promise.reject(new XgetNetException(status, statusText));
  const acceptsRanges = typeof unHEADRangeable === 'boolean' ? !unHEADRangeable : headers['accept-ranges'] === 'bytes';
  if (!Number.isFinite(store.size))
    store.totalSize = headers['content-length'] ? parseFloat(headers['content-length']) : Infinity;
  if (!(store.chunkable = acceptsRanges && Number.isFinite(store.totalSize))) store.chunks = 1;

  const offset = await store.headHandler({
    chunks: store.chunks,
    headers,
    start: store.start,
    totalSize: store.totalSize,
    acceptsRanges: store.chunkable,
  });
  store.start = !acceptsRanges ? 0 : typeof offset === 'number' ? offset : store.start;
  if (!Number.isFinite(store.size)) store.size = store.totalSize - store.start;
  if (store.size < store.chunks) store.chunks = store.size < 5 ? 1 : 5;
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
    totalSize: store.totalSize,
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
        `$1An error occurred while creating a duplex transformer from the \`use\` middleware tagged [${tag}] $3${err.message}$2`,
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
        this.emit('retry', {
          meta: false,
          index,
          retryCount,
          maxRetries,
          bytesRead,
          totalBytes: data.size,
          lastErr,
          store: store.stack,
        }),
      )
      .once(
        'error',
        (data.errHandler = err => {
          err = Object(err);
          this.destroy(((err.index = index), err));
        }),
      ),
    data,
    store,
  });
  return xStream && store.useCache ? xStream.pipe(store.cache.new()) : xStream;
}

function handleLoad(store, loadData) {
  let caughtErr = false;
  const streams = loadData.chunkStack.slice(0).map((data, index, arr) => {
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

function initHead(store, opts) {
  xHeadData
    .call(this, store, opts)
    .then(loadData => {
      store.loaded = true;
      if (loadData.size < 0) {
        this.destroy(
          new Error(`The requested size is greater than the resource can provide [${store.start} > ${store.totalSize}]`),
        );
        return;
      }
      if (loadData.size === 0) {
        store.ended = true;
        this.push(null);
        return;
      }
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
      if (store.rQd) handleLoad.call(this, store, loadData);
      else this.once('rQd', handleLoad.bind(this, store, loadData));
    })
    .catch(err => {
      err = Object(err);
      const handler = err[this.constructor.errHandler];
      const errTag = `An error occurred while ${
        handler && handler.source
          ? `processing the data through the \`with\` middleware tagged [${handler.tag}]`
          : `${store.loaded ? 'processing information from' : 'collecting and parsing information from'} the URL`
      }`;
      if (err.stack) err.stack = err.stack.replace(/(.+?:\s)[^]+?((\s*)\s{2}at)/m, `$1${errTag}$3${err.message}$2`);
      if (err.message) err.message = `${errTag}: ${err.message}`;
      this.emit('error', err);
    });
}

function xonstructor(url, opts) {
  const store = {
    url,
    rQd: false,
    auto: true,
    core: merge2(),
    hash: {algorithm: null, data: null, hasher: null},
    size: null,
    cache: new StreamCache({size: 209715200}),
    ended: false,
    stack: new Map(),
    start: 0,
    chunks: 5,
    loaded: false,
    retries: 5,
    timeout: null,
    useCache: true,
    bytesRead: 0,
    chunkable: true,
    pipeStack: {},
    totalSize: null,
    withStack: {},
    headHandler: () => {},
  };
  if (XGET_CHECK_VAR(opts.use, 'opts.use', 'object', true)) (store.pipeStack = opts.use), delete opts.use;
  if (XGET_CHECK_VAR(opts.auto, 'opts.auto', 'boolean', true)) (store.auto = opts.auto), delete opts.auto;
  if (XGET_CHECK_VAR(opts.hash, 'opts.hash', 'string', true)) (store.hash.algorithm = opts.hash), delete opts.hash;
  if (XGET_CHECK_VAR(opts.size, 'opts.size', 'number', true)) (store.size = opts.size), delete opts.size;
  if (XGET_CHECK_VAR(opts.with, 'opts.with', 'object', true)) (store.withStack = opts.with), delete opts.with;
  if (XGET_CHECK_VAR(opts.cache, 'opts.cache', 'boolean', true)) store.useCache = opts.cache;
  if (XGET_CHECK_VAR(opts.start, 'opts.start', 'number', true)) (store.start = opts.start), delete opts.start;
  if (XGET_CHECK_VAR(opts.chunks, 'opts.chunks', 'number', true)) (store.chunks = opts.chunks), delete opts.chunks;
  if (XGET_CHECK_VAR(opts.retries, 'opts.retries', 'number', true)) (store.retries = opts.retries), delete opts.retries;
  if (XGET_CHECK_VAR(opts.timeout, 'opts.timeout', 'number', true)) (store.timeout = opts.timeout), delete opts.timeout;
  if (XGET_CHECK_VAR(opts.cacheSize, 'opts.cacheSize', 'number', true))
    store.cache.setCapacity(opts.cacheSize), delete opts.cacheSize;
  if (XGET_CHECK_VAR(opts.headHandler, 'opts.headHandler', 'function', true))
    (store.headHandler = opts.headHandler), delete opts.headHandler;

  Object.entries(store.pipeStack).forEach(([key, value]) => XGET_CHECK_VAR(value, `opts.use[${key}]`, 'function'));
  Object.entries(store.withStack).forEach(([key, value]) => XGET_CHECK_VAR(value, `opts.with[${key}]`, 'function'));

  if (store.hash.algorithm) {
    if (!crypto.getHashes().includes(store.hash.algorithm)) throw new XgetException('opts.hash must be a valid hash algorithm');
    store.hash.hasher = new crypto.Hash(store.hash.algorithm);
  }

  if (store.auto) initHead.call(this, store, opts);

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
  let started = false;
  this.start = () => !store.auto && !started && (initHead.call(this, store, opts), (started = true));
  this.setHeadHandler = fn =>
    !!(XGET_CHECK_VAR(fn, 'fn', 'function', false) && !store.loaded) && ((store.headHandler = fn), true);
  this.getHash = (encoding = 'hex') => {
    let hash = null;
    if (store.hash.hasher) {
      hash = store.ended ? store.hash.data : store.hash.hasher.copy().digest();
      if (encoding) hash = hash.toString(encoding);
    }
    return hash;
  };
  this.getHashAlgorithm = () => store.hash.algorithm;
  this.setCacheSize = size => {
    if (XGET_CHECK_VAR(size, 'size', 'number', false)) store.cache.setCapacity(size);
    return this;
  };
  this.use = (tag, fn) => {
    if (store.loaded) throw new XgetException('failed to attach `use` middleware: content already loaded');
    XGET_CHECK_VAR(fn, 'fn', 'function');
    XGET_CHECK_VAR(tag, 'tag', 'string');
    store.pipeStack[tag] = fn;
    return this;
  };
  this.with = (tag, fn) => {
    if (store.loaded) throw new XgetException('failed to attach `with` middleware: content already loaded');
    XGET_CHECK_VAR(fn, 'fn', 'function');
    XGET_CHECK_VAR(tag, 'tag', 'string');
    store.withStack[tag] = fn;
    return this;
  };
  this.getErrContext = raw => ({raw, ...raw[this.constructor.errHandler]});
}

export class XGETStream extends stream.Readable {
  static errHandler = Symbol('XgetErrHandle');

  constructor(url, opts) {
    super();
    xonstructor.call(this, url, opts);
  }
}

export default function xget(url, opts) {
  const xtr = new XGETStream(url, opts);
  return xtr;
}
