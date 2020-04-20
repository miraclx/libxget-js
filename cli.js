#!/usr/bin/env node
const fs = require('fs');
const url = require('url');
const tty = require('tty');
const path = require('path');
const util = require('util');

const xbytes = require('xbytes');
const mime = require('mime-types');
const commander = require('commander');
const xprogress = require('xprogress');
const cStringd = require('stringd-colors');
const contentType = require('content-type');
const contentDisposition = require('content-disposition');

const xget = require('.');
const packageJson = require('./package.json');
const {XgetException} = require('./lib/xgetception');

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

function getRetryMessage({index, retryCount, maxRetries, bytesRead, totalBytes, lastErr}) {
  return cStringd(
    [
      ':{color(red)}{⯈}:{color:close(red)} ',
      `:{color(cyan)}@${index + 1}:{color:close(cyan)}`,
      `{:{color(yellow)}${retryCount}:{color:close(yellow)}${
        Number.isFinite(maxRetries) ? `/:{color(yellow)}${maxRetries}:{color:close(yellow)}` : ''
      }}: `,
      `[:{color(yellow)}${(lastErr && lastErr.code) || lastErr}:{color:close(yellow)}] `,
      `(:{color(cyan)}${
        Number.isFinite(totalBytes) ? `${bytesRead}`.padStart(`${totalBytes}`.length, ' ') : bytesRead
      }:{color:close(cyan)}${Number.isFinite(totalBytes) ? `/:{color(cyan)}${totalBytes}:{color:close(cyan)}` : ''})`,
    ].join(''),
  );
}

function getEndMessage(request) {
  return [
    `• Download Complete at ${request.bytesRead}`,
    ...(request.getHash() ? [`• Hash(${request.getHashAlgorithm()}): ${request.getHash('hex')}`] : []),
  ];
}

function parseExt(npath, ext) {
  const rext = path.extname(npath);
  return rext ? npath : path.join(path.dirname(npath), path.basename(npath, rext) + ext);
}

function processArgs(_url, outputFile, options) {
  const parsedUrl = url.parse(_url);
  if (!['protocol', 'hostname'].every(item => parsedUrl[item]))
    error('\x1b[31m[i]\x1b[0m Please enter a valid URL'), process.exit(1);

  function CHECK_FLAG_VAL(variable, flagref, untype) {
    // eslint-disable-next-line valid-typeof
    if (typeof variable !== untype)
      if (!(parseFloat(variable).toString() === variable && parseFloat(variable) >= 0))
        throw new XgetException(`\`${flagref}\` if specified, must be given a valid positive \`${untype}\` datatype`);
      else variable = parseInt(variable, 10);
    return variable;
  }

  try {
    options.tries = CHECK_FLAG_VAL(options.infiniteRetries ? Infinity : options.tries, '-t, --tries', 'number');
    options.chunks = CHECK_FLAG_VAL(options.chunks, '-n, --chunks', 'number');
    options.startPos = CHECK_FLAG_VAL(options.startPos, '--start-pos', 'number');
    options.timeout = CHECK_FLAG_VAL(options.timeout, '--timeout', 'number');
    options.verbose = options.verbose || false;
    options.continue = options.continue || false;
    options.singleBar = options.singleBar || false;
    options.pulsateBar = options.pulsateBar || false;
  } catch (er) {
    error('\x1b[31m[i]\x1b[0m', er.message);
    process.exit(1);
  }

  log(`URL:`, _url);
  const opts = {
    chunks: options.chunks,
    hash: options.hash,
    timeout: options.timeout,
    start: options.startPos,
    retries: options.tries,
  };

  const request = xget(_url, opts);

  if (options.bar)
    request
      .with('progressBar', ({size, chunkStack}) =>
        xprogress.stream(
          size,
          chunkStack.map(chunk => chunk.size),
          {
            label: outputFile || '<stdout>',
            forceFirst: options.singleBar || chunkStack.length > 20,
            length: 40,
            pulsate: options.pulsateBar || !Number.isFinite(size),
            bar: {separator: '|', header: ''},
            template: ['[:{label}]', ':{bars}'],
            variables: {
              bars: ({total}) =>
                (Number.isFinite(total) && !options.singleBar && chunkStack.length > 1 && chunkStack.length < 20
                  ? [' •|:{bar:complete}| [:3{percentage}%] [:{speed}] (:{eta})', ' •[:{bar}] [:{size}]']
                  : [` •|:{bar}|${Number.isFinite(total) ? ' [:3{percentage}%]' : ''} [:{speed}] (:{eta}) [:{size}]`]
                ).join('\n'),
              size: (stack, _size, total) => (
                (total = stack.total), `${stack.size()}${total !== Infinity ? `/:{size:total}` : ''}`
              ),
            },
          },
        ),
      )
      .use('progressBar', (dataSlice, store) => store.get('progressBar').next(dataSlice.size))
      .on('retry', data => data.store.get('progressBar').print(getRetryMessage(data)))
      .on('end', () => {
        request.store.get('progressBar').end(
          getEndMessage(request)
            .concat('')
            .join('\n'),
        );
      });
  else request.on('retry', data => log(getRetryMessage(data))).on('end', () => log(getEndMessage(request).join('\n')));

  request
    .on('loaded', ({size, chunkable, chunkStack, headers}) => {
      if ((!chunkable && options.startPos > 0) || options.continue)
        log(
          cStringd(
            `:{color(yellow)}{i}:{color:close(yellow)} Server doesn't support byteRanges. ${
              options.startPos !== 0
                ? ':{color(cyan)}`--start-pos`:{color:close(cyan)} ignored.'
                : options.continue
                ? `Cannot resume.`
                : ''
            }`,
          ),
        );

      const {type} = contentType.parse(headers['content-type'] || 'application/octet-stream');
      const ext = mime.extension(type);
      const {filename} = headers['content-disposition']
        ? contentDisposition.parse(headers['content-disposition']).parameters
        : {};

      outputFile = process.stdout.isTTY
        ? (_path =>
            path.join(
              options.directoryPrefix || (path.isAbsolute(_path) ? '/' : '.'),
              !options.directories ? path.basename(_path) : _path,
            ))(
            outputFile ||
              (filename
                ? decodeURI(filename)
                : parseExt(
                    parsedUrl.pathname && parsedUrl.pathname === '/' ? `index` : path.basename(parsedUrl.pathname),
                    `.${ext}` || '.html',
                  )),
          )
        : null;

      log(`Chunks: ${chunkable ? chunkStack.length : 1}`);
      log(`Length: ${Number.isFinite(size) ? `${size} (${xbytes(size)})` : 'unspecified'} ${type ? `[${type}]` : ''}`);
      log(`Saving to: ‘${outputFile || '<stdout>'}’...`);
      request.pipe(outputFile ? fs.createWriteStream(outputFile) : process.stdout);
    })
    .on('error', err => log('cli>', err));
}

const command = commander
  .name('xget')
  .usage('[options] <url> [outputFile]')
  .arguments('<url> [outputFile]')
  .description(packageJson.description)
  .option('-n, --chunks <N>', 'set number of concurrent chunk streams to N', 5)
  .option('-c, --continue', 'resume getting a partially downloaded file')
  .option('-t, --tries <N>', 'set number of retries for each chunk to N', 5)
  .option('-s, --hash [algorithm]', 'calculate hash sum for the requested content using the specified algorithm')
  .option('-D, --directory-prefix <PREFIX>', 'save files to PREFIX/..')
  .option('-i, --start-pos <OFFSET>', 'start downloading from zero-based position OFFSET', 0)
  .option('-I, --infinite-retries', 'retry each chunk infinitely')
  .option('--timeout <N>', 'network inactivity timeout (ms)', 10000)
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
  if (!argv.includes('-V')) {
    const credits = `libxget v${packageJson.version} - (c) ${packageJson.author}`;
    log(credits);
    log('-'.repeat(credits.length));
    if (!argv.slice(2).filter(v => v !== '-').length) commander.outputHelp();
  }
  command.parse(argv);
}

main(process.argv);
