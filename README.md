# libxget-js

> Non-interractive, chunk-based, web content retriever

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]

[![NPM][npm-image-url]][npm-url]

## Installing

Via [NPM][npm]:

```bash
# as a dependency
npm install libxget

# as a command
npm install -g libxget
```

This installs a CLI command accessible with the `xget` command.

```bash
# Check if the xget command has been installed and accessible on your path
$ xget -V
v0.8.1
```

## Usage

### CLI

The `xget` command, utilizes the library to retrieve web content by its chunks according to specification

```bash
# Normal
xget https://google.com/doodle.png

# Write to output file
xget https://google.com/doodle.png image.png

# Piping output
xget https://myserver.io/runtime.log --no-bar | less

# Stream response in real time (e.g Watching a movie)
xget https://service.com/movie.mp4 | vlc -
```

Use `--help` to see full usage documentation.

### Programmatically

```javascript
// Node CommonJS
const xget = require("libxget");
// Or ES6 Modules
import xget from "libxget";
// Or Typescript
import * as xget from "libxget";
```

#### Examples

```javascript
xget("https://github.com/microsoft/TypeScript/archive/master.zip", {
  chunks: 10,
  retries: 10,
}).pipe(fs.createWriteStream("master.zip"));
```

Get the master branch of the Typescript repository.
With 10 simultaneous downloads. Retrying each one to a max of 10.

## How it works

``` txt
                             |progress|    |=========|
     /- xresilient[axios] -> || part || -> || cache || -\
     /- xresilient[axios] -> || part || -> || cache || -\
     /- xresilient[axios] -> || part || -> || cache || -\
URL ->  xresilient[axios] -> || part || -> || cache ||  -> chunkmerger [ -> hasher ] -> output
     \- xresilient[axios] -> || part || -> || cache || -/
     \- xresilient[axios] -> || part || -> || cache || -/
     \- xresilient[axios] -> || part || -> || cache || -/
                             |progress|    |=========|
```

xget, using the [axios](https://github.com/axios/axios) library first infers from an abrupt [GET](https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods/GET) response whether or not the server supports byte-ranges through [Accept-Ranges](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Ranges) or [Content-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Range).
In the event that it does, it opens N connections feeding in non-overlapping segments of the resource. In order to retry broken connections, xget wraps the request generator in [xresilient](https://github.com/miraclx/xresilient) streams to ensure proper retries and probable completion of each chunk stream. The streams are piped and tracked through the [progress bar](https://github.com/miraclx/xprogress) and into a [caching stream](lib/streamCache.js) and then all chunks are [merged](https://github.com/teambition/merge2) sequentially, in-place and in-order and piped into an optional hasher and finally the output.

The purpose of the caching stream is to ensure that other chunks can begin while the merger is still writing previous chunks. Liberating the download speed from the write speed, recieved chunks are buffered in memory to a maximum cache limit.
The cacher also comes after the progress bar to ensure it properly measures the download speed and not the disk write speed, in the case where disk speed is slower than the network, although unlikely.

The purpose of the hasher is to check the integrity of the merged chunks while writing instead of that being a separate process. Very useful for large-file downloads, so you only process the file once, while downloading.

## API

### xget(url[, options])

- `url`: &lt;[string][]&gt;
- `options`: &lt;[XGETOptions](#xgetoptions)&gt;
- Returns: &lt;[XGETStream](#xgetstream)&gt;

### <a id='xgetoptions'></a> XGETOptions <sub>`extends`</sub> [AxiosOpts][]: [`Object`][object]

- `chunks`: &lt;[number][]&gt; Maximum number of non-overlapping chunk connections. **Default**: `5`
- `retries`: &lt;[number][]&gt; Number of retries for each chunk. **Default**: `5`
- `timeout`: &lt;[number][]&gt; Network response timeout (ms). **Default**: `20000`
- `start`: &lt;[number][]&gt; Position to start feeding the stream from. **Default**: `0`
- `auto`: &lt;[boolean][]&gt; Whether or not to start the request automatically or wait for a `request.start()` call (useful when chaining events you want to fire in order). **Default**: `true`
- `size`: &lt;[number][]&gt; Number of bytes to stream off the response.
- `hash`: &lt;[string][]&gt; Hash algorithm to use to create a [crypto.Hash][] instance computing the stream hash.
- `cache`: &lt;[number][]&gt; Whether or not to use an in-memory cache to enable read-aheads of pending chunks.
- `cacheSize`: &lt;[boolean][]&gt; Custom maximum cache size (bytes).
- `use`: &lt;[object][]&gt; Key-value pairs of middlewares with which to pipe the response object through. keys are [strings][string], values are [Transformer generating functions](#usemiddlewarefn) (Alternatively, use the [xget.use()](#xgetuse) method).
- `with`: &lt;[object][]&gt; Key-value pairs of middlewares with which to pipe the dataslice object through. keys are [strings][string], values are [functions][function] whose return values are accessible within the [store](#storestack). (Alternatively, use the [xget.with()](#xgetwith) method).
- `headHandler`: &lt;[HeadHandler](#headhandler)&gt; An interceptor for the initial headers, useful for programmatically defining a range offset;

### <a id='xgetstore'></a> xget.store: [`Map`][map]

A map whose keys and values are tags and return types of content processed within the withStack of the xget object.

```javascript
xget(URL)
  .with("variable", () => 5)
  .once("set", (store) => {
    /*
      `store` is a map whose key and values directly match tags and return types within
       > a with call or the with object in the xget options
    */
    console.log(store.get("variable")); // 5
  })
  .pipe(FILE);
```

### xget.ended: [`Boolean`][boolean]

A readonly property that tells whether or not the xget instance has ended.

### xget.loaded: [`Boolean`][boolean]

A readonly property that tells whether or not the xget instance has been loaded.

### xget.bytesRead: [`Number`][number]

A readonly property that tells how many bytes has been processed by the underlying streams.

### <a id='xgetstream'></a> Class: XGETStream <sub>`extends`</sub> [stream.Readable][]

The core multi-chunk request instance.

### new xget.XGETStream(url[, options])

- `url`: &lt;[string][]&gt;
- `options`: &lt;[XGETOptions](#xgetoptions)&gt;
- Returns: &lt;[XGETStream](#xgetstream)&gt;

### Event: 'end'

The `'end'` event is emitted after the data from the URL has been fully flushed.

### Event: 'set'

- `store`: &lt;[xget.store](#xgetstore)&gt; The shared internal data store.

The `'set'` event is emitted after all the middlewares defined in the `with` option of the [XGETOptions](#xgetoptions) or with the [xget.with()](#xgetwith) method.

This event is fired after the `'loaded'` event.

### Event: 'error'

- `err`: &lt;[Error][]&gt; The error instance.

The `'error'` event is emitted once a chunk has met it's maximum number of retries.
At which point, it would abruptly destroy other chunk connections.

### Event: 'retry'

- `retrySlice`:
  - `meta`: &lt;[boolean][]&gt; Whether or not the error causing the retry was caused while getting the URL metadata. i.e before any streams are employed.
  - `index`: &lt;[number][]&gt; The index count of the chunk.
  - `retryCount`: &lt;[number][]&gt; The number of retry iterations so far.
  - `maxRetries`: &lt;[number][]&gt; The maximum number of retries possible.
  - `bytesRead`: &lt;[number][]&gt; The number of bytes previously read (if any).
  - `totalBytes`: &lt;[number][]&gt; The total number of bytes that are to be read by the stream.
  - `lastErr`: &lt;[Error][]&gt; The error emitted by the previous stream.
  - `store`: &lt;[xget.store](#xgetstore)&gt; The shared internal data store.

The `'retry'` event is emitted by every chunk once it has been re-initialized underneath.
Based on the spec of the [xresilient][] module, chunks are reinitialized once an error event is met.

### Event: 'loaded'

- `loadData`: &lt;[LoadData](#loaddata)&gt; The pre-computed config for the loaded data slice.

This is emitted right after the initial headers data is gotten, preprocessed, parsed and used to tailor the configuration for the chunk setup.

This `loadData` contains information like the actual size of the remote file and whether or not the server supports multiple connections, chunking, file resumption, etc.

This event is fired after calling the headHandler and prior to the `'set'` event.

### xget.start()

- Returns: &lt;[boolean][]&gt;

Starts the request process if `options.auto` was set to false.

Returns `true` if the request was started, `false` if it had already been started.

### xget.getHash([encoding])

- `encoding`: &lt;[string][]&gt; The character encoding to use. **Default**: `'hex'`
- Returns: &lt;[Buffer][]&gt; | &lt;[string][]&gt;

Calculates the digest of all data that has been processed by the library and its middleware transformers.
This, creates a deep copy of the internal state of the current [crypto.Hash][] object of which it calculates the digest.

This ensures you can get a hash of an instancce of the data even while still streaming from the URL response.

### xget.getHashAlgorithm()

- Returns: &lt;[string][]&gt;

Returns the hash algorithm if any is in use.

### xget.setHeadHandler()

- `fn`: &lt;[HeadHandler](#headhandler)&gt; Handler to be set.
- Returns: &lt;[boolean][]&gt; Whether or not the handler was successfully set.

Sets an interceptor for the initial headers, useful for programmatically defining a range offset. Returns `false` if the request has already been loaded, `true` if successfully set.

### xget.setCacheCapacity()

- `size`: &lt;[number][]&gt;
- Returns: &lt;[XGETStream](#xgetstream)&gt;

Set maximum capacity for internal cache.

### <a id='xgetuse'></a> xget.use(tag, handler)

- `tag`: &lt;[string][]&gt;
- `handler`: &lt;[UseMiddlewareFn](#usemiddlewarefn)&gt;
- Returns: &lt;[XGETStream](#xgetstream)&gt;

Add a named handler to the use middleware stack whose return value would be used to transform the response stream in a series of pipes.

The `handler` method is called after the stream is requested from and we start pumping the underlying `request` instances for a data response stream.

The core expects the `handler` to return a [stream.Duplex] instance. (A readable, writable stream) to transform or passthrough the raw data streams along the way.

```javascript
// Example, compressing the response content in real time
xget(URL)
  .use("compressor", () => zlib.createGzip())
  .pipe(createWriteStreamSomehow());
```

### <a id='xgetwith'></a> xget.with(tag, handler)

- `tag`: &lt;[string][]&gt;
- `handler`: &lt;[WithMiddlewareFn](#withmiddlewarefn)&gt;
- Returns: &lt;[XGETStream](#xgetstream)&gt;

Add a named `handler` to the with middleware stack whose return value would be stored within the [store](#xgetstore) after execution.

```javascript
xget(URL)
  .with("bar", ({ size }) => progressBar(size)) // Create a finite-sized progress bar
  .use("bar", (_, store) => store.get("bar").genStream()) // Create a stream handling object that updates the progressbar from the number of bytes flowing through itself
  .once("set", (store) => store.get("bar").print("Downloading..."))
  .pipe(createWriteStreamSomehow());
```

### <a id='xgetgeterrcontext'></a> xget.getErrContext(err)

- `err`: &lt;[Error][]&gt;
- Returns: &lt;[Object][]&gt;
  - `raw`: &lt;[Error][]&gt;
  - `tag`: &lt;[string][]&gt; The tag of the middleware function as defined.
  - `source`: &lt;`'xget:with'`&gt; | &lt;`'xget:use'`&gt; The type of middleware from which the error was emitted.

Extract data from an error if it was either thrown from within a [UseMiddlewareFn](#usemiddlewarefn) or a [WithMiddlewareFn](#withmiddlewarefn) function.

```javascript
xget(URL)
  .use('errorThrower', () => {
    throw new Error('Custom error being thrown');
  })
  .once('error', err => {
    const ({tag, source}) = xget.getErrContext(err);
    if (source)
      console.log(`Error thrown from within the [${tag}] method of the [${source}] middlware`);
    // Error thrown from within the [errorThrower] method of the [xget:use] middleware
  })
  .pipe(createWriteStreamSomehow());

```

### <a id='headhandler'></a> HeadHandler: [`function`][function]

- `props`: &lt;[object][]&gt;
  - `chunks`: &lt;[number][]&gt; Number of chunks the resource can simultaneously provide.
  - `headers`: &lt;[IncomingHttpHeaders][incominghttpheaders]&gt; GET headers from the URL.
  - `totalSize`: &lt;[number][]&gt; Actual size of the resource without an offset.
  - `acceptsRanges`: &lt;[boolean][]&gt; Whether or not the URL resource accepts byte ranges.
- Returns: &lt;[number] | void&gt; An offset to begin streaming from. Analogous to the `.start` field in [XGETOptions](#xgetoptions). If void, defaults to `.start` or `0`;

An interceptor for the initial GET data, useful for programmatically defining a range offset.

### <a id='loaddata'></a> LoadData: [`Object`][object]

- `url`: &lt;[string][]&gt; The URL specified.
- `size`: &lt;[number][]&gt; Finite number returned if server responds appropriately, else `Infinity`.
- `start`: &lt;[number][]&gt; Sticks to specification if server allows chunking via `content-ranges` else, resets to `0`.
- `chunkable`: &lt;[number][]&gt; Whether or not the URL feed can be chunked, supporting simultaneous connections.
- `totalSize`: &lt;[number]&gt; Actual size of the resource without an offset.
- `chunkStack`: &lt;[ChunkLoadInstance](#chunkloadinstance)[]&gt; The chunkstack array.
- `headers`: &lt;[IncomingHttpHeaders][incominghttpheaders]&gt; The headers object.

### <a id='chunkloadinstance'></a> ChunkLoadInstance: [`Object`][object]

- `min`: &lt;[number][]&gt; The minimum extent for the chunk segment range.
- `max`: &lt;[number][]&gt; The maximum extent for the chunk segment range.
- `size`: &lt;[number][]&gt; The total size of the chunk segment.
- `stream`: &lt;[ResilientStream][resilientstream]&gt; A resilient stream that wraps around a request instance.

### <a id='withmiddlewarefn'></a> WithMiddlewareFn: [`Function`][function]

- `loadData`: &lt;[LoadData](#loaddata)&gt;

This `handler` is called immediately after metadata from URL is loaded that describes the response.
That is, pre-streaming data from the GET response like size (content-length), content-type, filename (content-disposition), whether or not it's chunkable (accept-ranges, content-range) and a couple of other criterias.

This information is passed into a handler whose return value is filed within the [store](#xgetstore) referenced by the `tag`.

### <a id='usemiddlewarefn'></a> UseMiddlewareFn: [`Function`][function]

- `dataSlice`: &lt;[ChunkLoadInstance](#chunkloadinstance)&gt;
- `store`: &lt;[xget.store](#xgetstore)&gt;
- Returns: &lt;[stream.Duplex][]&gt;

## CLI Info

- To avoid the terminal being cluttered while using pipes, direct other chained binaries' `stdout` and `stderr` to `/dev/null`

```bash
# Watching from a stream, hiding vlc's log information
xget https://myserver.com/movie.mp4 | vlc - > /dev/null 2>&1
```

## Development

### Building

Feel free to clone, use in adherance to the [license](#license) and perhaps send pull requests

```bash
git clone https://github.com/miraclx/libxget-js.git
cd libxget-js
npm install
# hack on code
npm run build
```

## License

[Apache 2.0][license] © **Miraculous Owonubi** ([@miraclx][author-url]) &lt;omiraculous@gmail.com&gt;

[npm]: https://github.com/npm/cli "The Node Package Manager"
[license]: LICENSE "Apache 2.0 License"
[author-url]: https://github.com/miraclx
[npm-url]: https://npmjs.org/package/libxget
[npm-image]: https://badgen.net/npm/node/libxget
[npm-image-url]: https://nodei.co/npm/libxget.png?stars&downloads
[downloads-url]: https://npmjs.org/package/libxget
[downloads-image]: https://badgen.net/npm/dm/libxget
[xresilient]: https://github.com/miraclx/xresilient
[axiosopts]: https://github.com/axios/axios#request-config
[resilientstream]: https://github.com/miraclx/xresilient#resilientstream
[buffer]: https://nodejs.org/api/buffer.html#buffer_class_buffer
[crypto.hash]: https://nodejs.org/api/crypto.html#crypto_crypto_createhash_algorithm_options
[stream.duplex]: https://nodejs.org/api/stream.html#stream_new_stream_duplex_options
[stream.readable]: https://nodejs.org/api/stream.html#stream_class_stream_readable
[incominghttpheaders]: https://nodejs.org/api/http.html#http_message_headers
[map]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
[error]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
[number]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type
[object]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object
[string]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type
[boolean]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type
[function]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function
