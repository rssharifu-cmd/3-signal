const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// v1: magic/version (8), nonce (12), ciphertext (N), GCM tag (16).
// All 20 header bytes are authenticated as AAD. Payload is a gzip mongodump archive.
const MAGIC = Buffer.from('SHRFBK01', 'ascii');
const HEADER_SIZE = 20;
const TAG_SIZE = 16;
function parseKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid backup encryption key');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid backup encryption key');
  return key;
}
function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid backup encryption key');
}
async function encryptToFile(input, output, key, { signal } = {}) {
  checkKey(key);
  const header = Buffer.concat([MAGIC, randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(8), { authTagLength: TAG_SIZE });
  cipher.setAAD(header);
  let owned = false, sourceError;
  // Capture a source failure that can arrive while the exclusive destination is opening.
  const onSourceError = error => { sourceError = error; };
  input.on('error', onSourceError);
  try {
    // Own the exclusive file before cleanup; never remove a pre-existing destination.
    const handle = await fsp.open(output, 'wx', 0o600);
    owned = true;
    if (sourceError) { await handle.close(); throw sourceError; }
    const envelope = new Transform({
      construct(callback) { this.push(header); callback(); },
      transform(chunk, _encoding, callback) { callback(null, chunk); },
      flush(callback) { this.push(cipher.getAuthTag()); callback(); },
    });
    await pipeline(input, cipher, envelope, handle.createWriteStream(), { signal });
  } catch (err) {
    if (owned) await fsp.rm(output, { force: true });
    throw err;
  } finally { input.removeListener('error', onSourceError); }
}
async function frame(input) {
  const handle = await fsp.open(input, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < HEADER_SIZE + TAG_SIZE) throw new Error('Invalid backup format');
    const header = Buffer.alloc(HEADER_SIZE), tag = Buffer.alloc(TAG_SIZE);
    await handle.read(header, 0, HEADER_SIZE, 0);
    await handle.read(tag, 0, TAG_SIZE, stat.size - TAG_SIZE);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Unsupported backup format');
    return { header, tag, size: stat.size };
  } finally { await handle.close(); }
}
async function decryptPass(input, output, key, framing, signal) {
  const { header, tag, size } = framing;
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8), { authTagLength: TAG_SIZE });
  decipher.setAAD(header); decipher.setAuthTag(tag);
  const source = size === HEADER_SIZE + TAG_SIZE ? require('node:stream').Readable.from([]) :
    fs.createReadStream(input, { start: HEADER_SIZE, end: size - TAG_SIZE - 1 });
  await pipeline(source, decipher, output, { signal });
}
async function verifyFile(input, key, { signal } = {}) {
  checkKey(key);
  const framing = await frame(input);
  await decryptPass(input, new Writable({ write(_chunk, _encoding, done) { done(); } }), key, framing, signal);
  return framing;
}
async function decryptToFile(input, output, key) {
  // Authenticate once without releasing plaintext before creating the private restore file.
  // A second authenticated pass writes it; on any failure the partial file is removed.
  const framing = await verifyFile(input, key);
  let owned = false;
  try {
    const handle = await fsp.open(output, 'wx', 0o600); owned = true;
    await decryptPass(input, handle.createWriteStream(), key, framing);
  } catch (err) {
    if (owned) await fsp.rm(output, { force: true });
    throw err;
  }
}
if (require.main === module) {
  (async () => {
    let key;
    try {
      const [action, input, output, ...extra] = process.argv.slice(2);
      if (!input || extra.length || !['encrypt', 'decrypt', 'verify'].includes(action) ||
          (action !== 'verify' && !output) || (action === 'verify' && output)) throw new Error('Invalid arguments');
      key = parseKey(process.env.BACKUP_ENCRYPTION_KEY);
      if (action === 'encrypt') await encryptToFile(fs.createReadStream(input), output, key);
      else if (action === 'decrypt') await decryptToFile(input, output, key);
      else await verifyFile(input, key);
      console.log('Backup cryptography completed successfully.');
    } catch { console.error('Backup cryptography failed; verify arguments, key, file format and integrity.'); process.exitCode = 1; }
    finally { if (key) key.fill(0); }
  })();
}
module.exports = { parseKey, encryptToFile, decryptToFile, verifyFile, HEADER_SIZE, TAG_SIZE };
