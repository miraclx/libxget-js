# libxget-js

> Non-interractive, chunk-based, web content retriever

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]

[![NPM][npm-image-url]][npm-url]

## Installing

Via [NPM][npm]:

``` bash
npm install libxget
```

This installs a CLI binary accessible with the `xget` command.

``` bash
# Check if the xget command has been installed and accessible on your path
$ xget -v
v0.0.1
```

## Usage

### CLI

The `xget` command, utilizes the library to retrieve web content by its chunks according to specification

``` bash
# Normal
xget https://google.com/doodle.png

# Write to output file
xget https://google.com/doodle.png image.png

# Piping output
xget https://myserver.io/runtime.log --no-bar | less

# Stream response in real time (e.g Watching the movie)
xget https://service.com/movie.mp4 | vlc -
```

Use `--help` to see full usage documentation.

### Programmatically

``` javascript
// Node CommonJS
const libxget = require('libxget');
// Or ES6
import libxget from 'libxget';
```

## Examples

## API

## ClI Info

* To avoid the terminal being cluttered while using pipes, direct other chained binaries' `stdout` and `stderr` to `/dev/null`

``` bash
# Watching from a stream, hiding vlc's log information
xget https://myserver.com/movie.mp4 | vlc - > /dev/null 2>&1
```

## Development

### Building

Feel free to clone, use in adherance to the [license](#license) and perhaps send pull requests

``` bash
git clone https://github.com/miraclx/libxget-js.git
cd libxget-js
npm install
# hack on code
npm run build
```

## License

[Apache 2.0][license] © **Miraculous Owonubi** ([@miraclx][author-url]) &lt;omiraculous@gmail.com&gt;

[npm]:  https://github.com/npm/cli "The Node Package Manager"
[license]:  LICENSE "Apache 2.0 License"
[author-url]: https://github.com/miraclx

[npm-url]: https://npmjs.org/package/libxget
[npm-image]: https://badgen.net/npm/node/libxget
[npm-image-url]: https://nodei.co/npm/libxget.png?stars&downloads
[downloads-url]: https://npmjs.org/package/libxget
[downloads-image]: https://badgen.net/npm/dm/libxget
