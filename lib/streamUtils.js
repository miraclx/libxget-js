import * as fs from 'fs';
import {Transform, Readable} from 'stream';

export function randomBytes(length, devZero) {
  if (!Number.isSafeInteger(length)) throw new Error('<size> is not a safe integer');

  if (devZero) return fs.createReadStream('/dev/zero', {end: length - 1});

  const source = new Readable({
    highWaterMark: Math.min(1 << 16, length),
    read(bytes) {
      this.push(Buffer.allocUnsafe(bytes));
    },
  });

  return source.pipe(sizedStream(length));
}

export function sizedStream(max) {
  return new Transform({
    writableHighWaterMark: Math.min(1 << 16, max),
    transform(chunk, _enc, cb) {
      this.cursor = this.cursor || 0;
      if (!Number.isFinite(max)) return cb(null, chunk);
      else if (this.cursor >= max) return cb();
      chunk = chunk.slice(0, max - this.cursor);
      this.buffer = !this.buffer ? chunk : chunk.length ? Buffer.concat([this.buffer, chunk]) : this.buffer;
      while (this.cursor < max && (this.buffer.length >= chunk.length || this.buffer.length >= this.readableHighWaterMark)) {
        const bytes = Math.min(this.readableHighWaterMark, max - this.cursor);
        const slice = this.buffer.slice(0, bytes);
        this.push(slice);
        this.cursor += slice.length;
        this.buffer = this.buffer.slice(bytes);
      }
      cb();
    },
    flush(cb) {
      this._transform(Buffer.alloc(0), null, cb);
    },
  });
}
