const fs = require('fs');
const tty = require('tty');
const url = require('url');
const path = require('path');
const util = require('util');

const commander = require('commander');
const xprogress = require('xprogress');

const xget = require('.');
const packageJson = require('./package.json');

const [log, error] = [, ,].fill(
  (function ninjaLoggers() {
    let output;
    if (!process.stdout.isTTY && ['linux', 'android', 'darwin'].includes(process.platform))
      (output = new tty.WriteStream(fs.openSync('/dev/tty', 'w'))), process.on('beforeExit', () => output.destroy());
    else output = process.stdout;
    return function ninjaLogger(...args) {
      output.write(`${util.format(...args)}\n`);
    };
  })(),
);

function processArgs(_url, outputFile, options) {
  const parsedUrl = url.parse(_url);
  if (!['protocol', 'hostname'].every(item => parsedUrl[item]))
    console.log('\x1b[31m[i]\x1b[0m Please enter a valid URL'), process.exit(1);
  outputFile = (_path => path.join(options.directoryPrefix || '.', !options.directories ? path.basename(_path) : _path))(
    outputFile || (parsedUrl.pathname && parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname),
  );
  options.tries = parseInt(options.tries, 10);
  options.chunks = parseInt(options.chunks, 10);
  options.start_pos = parseInt(options.start_pos, 10);
  options.verbose = options.verbose || false;
  options.continue = options.continue || false;
  options.singleBar = options.singleBar || false;
  options.pulsateBar = options.pulsateBar || false;

  log(`url:`, _url);
  log(`outputFile:`, outputFile);
  log(`chunks:`, options.chunks);
  log(`resume:`, options.continue);
  log(`max-retries:`, options.tries);
  log(`offset:`, options.startPos);
  log(`Show Progress:`, options.bar);
  log(`Pulsate Bar:`, options.pulsateBar);
  log(`Single Bar:`, options.singleBar);
  log(`Verbose:`, options.verbose);
  log();
  const opts = {
    chunks: options.chunks,
    timeout: 15000,
    retries: options.tries,
    with: {
      progressBar({size, chunkStack}) {
        return xprogress.stream(
          size,
          chunkStack.map(chunk => chunk.size),
          {
            label: outputFile,
            forceFirst: chunkStack.length > 20,
            length: 100,
            pulsate: !Number.isFinite(size),
            bar: {separator: '|', header: ''},
            template: [
              'Saving to: ‘:{label}’',
              '•|:{bar:complete}| [:3{percentage}%] [:{speed}] (:{eta})',
              '•[:{bar}] [:{size}]',
            ],
            variables: {
              size: (stack, _size, total) => (
                (total = stack['size:total:raw']), `${stack.size()}${total !== Infinity ? `/:{size:total}` : ''}`
              ),
            },
          },
        );
      },
    },
    use: {
      progressBar(dataSlice, store) {
        return store.get('progressBar').next(dataSlice.size);
      },
    },
  };

  const request = xget(_url, opts)
    .on('error', err => log(err))
    .on('loaded', data => log(`File Size: ${data.size}`))
    .on('end', () => request.store.get('progressBar').end(`Download Complete at ${request.bytesRead}\n`));

  request.pipe(fs.createWriteStream(outputFile));
}

const command = commander
  .name('xget')
  .usage('[options] <url> [outputFile]')
  .arguments('<url> [outputFile]')
  .description(packageJson.description)
  .option('-n, --chunks <N>', 'set number of concurrent chunk streams to N', 5)
  .option('-c, --continue', 'resume getting a partially downloaded file')
  .option('-t, --tries <N>', 'set number of retries for each chunk to N', 5)
  .option('-P, --directory-prefix <PREFIX>', 'save files to PREFIX/..')
  .option('--start-pos <OFFSET>', 'start downloading from zero-based position OFFSET', 0)
  .option('--no-directories', "don't create directories")
  .option('--no-bar', "don't show the ProgressBar")
  .option('--pulsate-bar', 'show a pulsating bar')
  .option('--single-bar', 'show a single bar for the download, hide chunk-view [default when n(chunks) exceed printable space]')
  .option('-q, --quiet', 'be stealth')
  .option('-v, --verbose', 'be verbose')
  .version(`v${packageJson.version}`, '-V, --version')
  // Add header config
  // Authentication
  // POST Request
  // Proxies
  // Cookiefile
  .action(processArgs);

function main(argv) {
  if (!argv.includes('-v')) {
    const credits = `libxget v${packageJson.version} - (c) ${packageJson.author}`;
    log(credits);
    log('-'.repeat(credits.length));
    if (!argv.slice(2).filter(v => v !== '-').length) commander.outputHelp();
  }
  command.parse(argv);
}

main(process.argv);
