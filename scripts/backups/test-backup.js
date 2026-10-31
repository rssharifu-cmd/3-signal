// Synthetic data only. Disable sockets and subprocess creation before importing backup tools.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
for (const name of Object.keys(process.env)) if (/MONGODB|BACKUP_ENCRYPTION|R2_|AWS_|RESEND/.test(name)) delete process.env[name];
const blocked = () => { throw new Error('Network/process access blocked in backup tests'); };
global.fetch = blocked;
require('node:net').Socket.prototype.connect = blocked;
require('node:tls').connect = blocked;
for (const protocol of ['http', 'https']) { require('node:' + protocol).request = blocked; require('node:' + protocol).get = blocked; }
require('node:child_process').spawn = blocked;
const crypto = require('./crypto');
const { runBackup, settings, dumpEncrypted, hashFile } = require('./run');
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sharflow-backup-test-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const key = randomBytes(32);
const envFor = root => ({ PATH: process.env.PATH, MONGODB_URI: 'mongodb://synthetic:synthetic@invalid.test/sharflow',
  BACKUP_ENCRYPTION_KEY: key.toString('base64'), R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'fake-access',
  R2_SECRET_ACCESS_KEY: 'fake-secret', R2_BUCKET_NAME: 'sharflow-backups',
  BACKUP_TEMP_ROOT: path.join(root, 'disk'), BACKUP_RAM_ROOT: path.join(root, 'ram') });

test('canonical Base64 key must decode to exactly 32 bytes', () => {
  assert.deepEqual(crypto.parseKey(key.toString('base64')), key);
  for (const bad of [undefined, '', 'not base64', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), key.toString('base64') + '\n']) assert.throws(() => crypto.parseKey(bad));
});
for (const length of [0, 1, 65537, 2 * 1024 * 1024]) test('AES-256-GCM authenticated round trip: ' + length + ' bytes', () => fixture(async root => {
  const data = randomBytes(length), encrypted = path.join(root, 'archive.shfb'), restored = path.join(root, 'restore.gz');
  await crypto.encryptToFile(Readable.from([data]), encrypted, key);
  await crypto.verifyFile(encrypted, key); await crypto.decryptToFile(encrypted, restored, key);
  assert.deepEqual(await fs.readFile(restored), data);
  assert.equal((await fs.stat(encrypted)).size, length + crypto.HEADER_SIZE + crypto.TAG_SIZE);
  if (process.platform !== 'win32') { assert.equal((await fs.stat(encrypted)).mode & 0o777, 0o600); assert.equal((await fs.stat(restored)).mode & 0o777, 0o600); }
}));
test('fresh random nonce makes repeated encryption different', () => fixture(async root => {
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  for (const output of [a, b]) await crypto.encryptToFile(Readable.from(['same synthetic archive']), output, key);
  assert.notDeepEqual((await fs.readFile(a)).subarray(8,20), (await fs.readFile(b)).subarray(8,20));
}));
for (const tamper of ['magic', 'nonce', 'ciphertext', 'tag', 'truncated', 'appended', 'wrong-key']) test('integrity rejects ' + tamper + ' without writing plaintext', () => fixture(async root => {
  const input = path.join(root, 'encrypted'), output = path.join(root, 'plaintext');
  await crypto.encryptToFile(Readable.from(['synthetic archive contents']), input, key);
  let bytes = await fs.readFile(input);
  const offsets = { magic: 0, nonce: 8, ciphertext: 20, tag: bytes.length - 1 };
  if (tamper in offsets) bytes[offsets[tamper]] ^= 1;
  if (tamper === 'truncated') bytes = bytes.subarray(0, 25);
  if (tamper === 'appended') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
  await fs.writeFile(input, bytes);
  await assert.rejects(crypto.decryptToFile(input, output, tamper === 'wrong-key' ? randomBytes(32) : key));
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
}));
test('existing encryption/decryption destinations are never overwritten or deleted', () => fixture(async root => {
  const input = path.join(root, 'encrypted'), output = path.join(root, 'existing'); await fs.writeFile(output, 'keep');
  await assert.rejects(crypto.encryptToFile(Readable.from(['payload']), output, key), { code: 'EEXIST' });
  await crypto.encryptToFile(Readable.from(['payload']), input, key);
  await assert.rejects(crypto.decryptToFile(input, output, key), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output, 'utf8'), 'keep');
}));
test('source stream failure removes partial ciphertext', () => fixture(async root => {
  const output = path.join(root, 'encrypted');
  async function* failing() { yield Buffer.from('synthetic'); throw Error('synthetic source failed'); }
  await assert.rejects(crypto.encryptToFile(Readable.from(failing()), output, key));
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
}));
test('settings fail closed for missing secrets, wrong bucket or unspecified/system database', () => fixture(async root => {
  const env = envFor(root); assert.equal(settings(env).bucket, 'sharflow-backups');
  for (const field of ['MONGODB_URI','BACKUP_ENCRYPTION_KEY','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME']) assert.throws(() => settings({...env,[field]:''}));
  for (const uri of ['mongodb://invalid.test/', 'mongodb://invalid.test/admin', 'mongodb://invalid.test/local', 'mongodb://invalid.test/config', 'https://invalid.test/sharflow']) assert.throws(() => settings({...env,MONGODB_URI:uri}));
  assert.throws(() => settings({...env,R2_BUCKET_NAME:'other'}));
}));
function fakeDumpProcess(code, data = 'synthetic gzip archive') {
  return (_command, args, options) => {
    assert.deepEqual(args, ['--config', 'private.yml', '--archive', '--gzip']);
    assert.equal(options.env.MONGODB_URI, undefined); assert.equal(options.env.BACKUP_ENCRYPTION_KEY, undefined);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    setImmediate(() => { child.stdout.end(data); child.emit('close',code); }); return child;
  };
}
for (const code of [0, 2]) test('mongodump exit ' + code + ' is checked independently of valid encryption', () => fixture(async root => {
  const archive = path.join(root,'encrypted');const options = {env:envFor(root),spawnProcess:fakeDumpProcess(code)};
  if (code === 0) { await dumpEncrypted('private.yml',archive,key,options);await crypto.verifyFile(archive,key); }
  else { await assert.rejects(dumpEncrypted('private.yml',archive,key,options));await assert.rejects(fs.stat(archive),{code:'ENOENT'}); }
}));
test('empty mongodump is a failure', () => fixture(async root => {
  const archive=path.join(root,'encrypted');await assert.rejects(dumpEncrypted('private.yml',archive,key,{env:envFor(root),spawnProcess:fakeDumpProcess(0,'')}));
  await assert.rejects(fs.stat(archive),{code:'ENOENT'});
}));
for (const failure of ['none', 'dump', 'upload', 'head-size', 'head-hash', 'download', 'download-corrupt', 'abort']) test('backup orchestration: ' + failure + ', encrypted-only upload and cleanup', () => fixture(async root => {
  const env=envFor(root),calls=[];let uploaded,uploadedHash,uploadedSize;
  const controller=new AbortController(); if(failure==='abort')controller.abort();
  const dump=async(config,output,actualKey)=>{
    assert.equal((await fs.readFile(config,'utf8')), 'uri: '+JSON.stringify(env.MONGODB_URI)+'\n');
    if(failure==='dump')throw Error(env.MONGODB_URI);
    await crypto.encryptToFile(Readable.from(['synthetic DB content']),output,actualKey,{signal:controller.signal});
  };
  const execute=async(command,args,options)=>{
    assert.equal(command,'aws');assert.equal(options.env.MONGODB_URI,undefined);assert.equal(options.env.BACKUP_ENCRYPTION_KEY,undefined);
    assert.equal(options.env.AWS_ACCESS_KEY_ID,env.R2_ACCESS_KEY_ID);assert.ok(args.includes('https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com'));
    calls.push(args);
    if(args.includes('head-object')){
      return JSON.stringify({ContentLength:uploadedSize+(failure==='head-size'?1:0),Metadata:{sha256:failure==='head-hash'?'wrong':uploadedHash}});
    }
    const cp=args.indexOf('cp'),source=args[cp+1],destination=args[cp+2];
    if(source.startsWith('s3://')){
      if(failure==='download')throw Error('sensitive provider response');
      await fs.writeFile(destination,failure==='download-corrupt'?Buffer.from('corrupt'):uploaded);return '';
    }
    if(failure==='upload')throw Error('sensitive provider response');
    uploaded=await fs.readFile(source);assert.equal(uploaded.subarray(0,8).toString(),'SHRFBK01');
    assert.equal(uploaded.includes(Buffer.from('synthetic DB content')),false);
    assert.match(destination,/^s3:\/\/sharflow-backups\/mongodb\/\d{4}\/\d{2}\/\d{2}\/.+\.shfb$/);
    uploadedHash=await hashFile(source);uploadedSize=uploaded.length;return '';
  };
  if(failure==='none') {const result=await runBackup({env,execute,dump,signal:controller.signal});assert.equal(result.sha256,uploadedHash);assert.equal(calls.length,3);}
  else await assert.rejects(runBackup({env,execute,dump,signal:controller.signal}),error=>!error.message.includes(env.MONGODB_URI)&&!error.message.includes('sensitive provider'));
  for(const name of ['disk','ram'])assert.deepEqual(await fs.readdir(path.join(root,name)),[]);
}));
test('workflow is daily 02:00 UTC, main-only, read-only token and no plaintext artifact', async()=>{
  const text=await fs.readFile(path.join(__dirname,'../../.github/workflows/mongodb-backup.yml'),'utf8');
  assert.match(text,/cron: '0 2 \* \* \*'/);assert.match(text,/workflow_dispatch:/);
  assert.match(text,/if: github.ref == 'refs\/heads\/main'/);assert.match(text,/contents: read/);
  assert.match(text,/mongodb-database-tools/);assert.match(text,/if: always\(\)/);assert.match(text,/stat -f -c %T \/dev\/shm/);
  assert.doesNotMatch(text,/upload-artifact|mongorestore|pull_request_target/);
  assert.doesNotMatch(text,/^\s+environment:/m, 'repository secrets must not require a new environment');
  for (const name of ['MONGODB_URI','BACKUP_ENCRYPTION_KEY','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME']) {
    assert.ok(text.includes(name + ': ' + '${{ secrets.' + name + ' }}'), 'exact repository secret reference: ' + name);
  }
  const runtime = await fs.readFile(path.join(__dirname,'run.js'),'utf8');
  assert.ok(runtime.includes('parseKey(env.BACKUP_ENCRYPTION_KEY)'), 'validate the exact key secret before encryption');
});

test('documented envelope interoperates with an independent GCM decoder',()=>fixture(async root=>{
 const encrypted=path.join(root,'backup');const data=Buffer.from('synthetic archive for format compatibility');
 await crypto.encryptToFile(Readable.from([data]),encrypted,key);const bytes=await fs.readFile(encrypted);
 assert.equal(bytes.subarray(0,8).toString('ascii'),'SHRFBK01');
 const decipher=require('node:crypto').createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));
 decipher.setAAD(bytes.subarray(0,20));decipher.setAuthTag(bytes.subarray(bytes.length-16));
 assert.deepEqual(Buffer.concat([decipher.update(bytes.subarray(20,-16)),decipher.final()]),data);
}));
test('early source failure is caught before destination pipeline attaches',()=>fixture(async root=>{
 const output=path.join(root,'partial');const source=new PassThrough();
 const promise=crypto.encryptToFile(source,output,key);source.destroy(Error('synthetic early error'));
 await assert.rejects(promise);await assert.rejects(fs.stat(output),{code:'ENOENT'});
}));
