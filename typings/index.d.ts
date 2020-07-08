// Type definitions for libxget-js
// Project: https://github.com/miraclx/libxget-js
// Definitions by: Miraculous Owonubi <https://github.com/miraclx>

/// <reference types="node" />

import stream = require('stream');
import xresilient = require('xresilient');
import {AxiosRequestConfig} from 'axios';
import {IncomingHttpHeaders} from 'http';

declare namespace xget {

  interface XgetException extends Error { }

  interface XgetNetException extends XgetException {
    statusCode: number;
    statusMessage: string;
  }

  interface XGETStream extends stream.Readable {
    constructor(url: string, options?: XGETOptions);
    on(event: string, listener: (...args: any[]) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'set', listener: (store: MiddlewareStore) => void): this;
    on(event: 'error', listener: (err: Error | XgetException | XgetNetException) => void): this;
    on(event: 'retry', listener: (slice: RetrySlice) => void): this;
    on(event: 'loaded', listener: (dataSlice: LoadDataSlice) => void): this;
    readonly store: MiddlewareStore;
    readonly ended: false;
    readonly loaded: false;
    readonly bytesRead: number;
    start(): boolean;
    getHash(): Buffer;
    getHash(encoding: string): string;
    getHashAlgorithm(): string;
    setCacheSize(size: number): this;
    setHeadHandler(fn: HeadHandler): boolean;
    use(tag: string, fn: UseMiddlewareFn): this;
    with(tag: string, fn: WithMiddlewareFn): this;
    getErrContext(err: Error): { raw: Error, tag: string, source: 'xget:with' | 'xget:use' }
  }

  interface XGETInstance {
    (url: string, options?: XGETOptions): XGETStream;
  }

  interface XGETOptions extends AxiosRequestConfig {
    use: UseObjectLiteral;
    auto: boolean;
    hash: string;
    size: number;
    with: WithMiddlewareFn;
    start: number;
    chunks: number;
    cache: boolean;
    cacheSize: number;
    retries: number;
    timeout: number;
    headHandler: HeadHandler;
  }

  interface ChunkLoadInstance {
    min: number;
    max: number;
    size: number;
    stream: xresilient.ResilientStream<NodeJS.ReadableStream>;
  }

  interface RetrySlice extends xresilient.RetrySlice<NodeJS.ReadableStream> {
    store: MiddlewareStore;
    index: number;
    totalBytes: number;
    meta: boolean;
  }

  interface LoadDataSlice {
    url: string;
    size: number;
    start: number;
    chunkable: boolean;
    totalSize: number;
    chunkStack: ChunkLoadInstance[];
    headers: IncomingHttpHeaders;
  }

  type MiddlewareStore = Map<string, any>;

  interface HeaderSlice {
    chunks: number;
    headers: IncomingHttpHeaders;
    totalSize: number;
    acceptsRanges: boolean;
  }

  type HeadHandler = (props: HeaderSlice) => number | void;
  type UseMiddlewareFn = (dataSlice: ChunkLoadInstance, store: MiddlewareStore) => NodeJS.ReadWriteStream;
  type WithMiddlewareFn = (loadData: LoadDataSlice) => any;

  interface UseObjectLiteral {
    [tag: string]: UseMiddlewareFn;
  }
  interface WithObjectLiteral {
    [tag: string]: WithMiddlewareFn;
  }
}

declare let xget: xget.XGETInstance;
export = xget;
