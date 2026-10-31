const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { parseKey, encryptToFile, verifyFile, HEADER_SIZE, TAG_SIZE } = require('./crypto');

function settings(env) {
  for (const name of ['MONGODB_URI', 'BACKUP_ENCRYPTION_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
    if (!env[name]) throw new Error('A required backup secret is missing');
  }
  // Require an explicit application DB; never silently dump every DB in a cluster.
  const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)(?:\?[^#]*)?$/.exec(env.MONGODB_URI);
  if (!match || !/^[A-Za-z0-9_.-]+$/.test(match[1]) || ['admin', 'local', 'config'].includes(match[1])) throw new Error('MongoDB URI must explicitly select an application database');
  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID) || env.R2_BUCKET_NAME !== 'sharflow-backups') throw new Error('Invalid R2 backup destination');
  return { endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, bucket: env.R2_BUCKET_NAME };
}
function minimalEnv(env) { return { PATH: env.PATH || process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }; }
function quietCommand(command, args, { env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, signal, stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '', exceeded = false;
    child.stdout.on('data', data => { if (text.length + data.length > 1024 * 1024) { exceeded = true; child.kill(); } else text += data; });
    child.on('error', () => reject(new Error('Backup subprocess could not start')));
    child.on('close', code => code === 0 && !exceeded ? resolve(text) : reject(new Error('Backup subprocess failed')));
  });
}
async function dumpEncrypted(config, archive, key, { env, signal, spawnProcess = spawn } = {}) {
  // stdout is the gzip archive, never a log. stderr is deliberately suppressed: tool errors can include URIs.
  const child = spawnProcess('mongodump', ['--config', config, '--archive', '--gzip'],
    { env: minimalEnv(env || process.env), signal, stdio: ['ignore', 'pipe', 'ignore'] });
  const exit = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('mongodump could not start')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('mongodump failed')));
  });
  const encrypted = encryptToFile(child.stdout, archive, key, { signal });
  try {
    await Promise.all([exit, encrypted]);
    if ((await fsp.stat(archive)).size <= HEADER_SIZE + TAG_SIZE) throw new Error('mongodump produced no archive');
  } catch (err) {
    child.kill('SIGTERM');
    await Promise.allSettled([exit, encrypted]);
    await fsp.rm(archive, { force: true });
    throw err;
  }
}
async function hashFile(file) {
  const hash = createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function runBackup({ env = process.env, execute = quietCommand, dump = dumpEncrypted, signal } = {}) {
  const destination = settings(env);
  let key, work, ram, stage = 'prepare';
  try {
    key = parseKey(env.BACKUP_ENCRYPTION_KEY);
    if (!env.BACKUP_TEMP_ROOT || !env.BACKUP_RAM_ROOT) throw new Error('Private temporary roots required');
    for (const root of [env.BACKUP_TEMP_ROOT, env.BACKUP_RAM_ROOT]) {
      await fsp.mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await fsp.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe temporary root');
    }
    work = await fsp.mkdtemp(path.join(env.BACKUP_TEMP_ROOT, 'run-'));
    ram = await fsp.mkdtemp(path.join(env.BACKUP_RAM_ROOT, 'run-'));
    const config = path.join(ram, 'mongodb.yml'), archive = path.join(work, 'backup.shfb');
    await fsp.writeFile(config, 'uri: ' + JSON.stringify(env.MONGODB_URI) + '\n', { mode: 0o600, flag: 'wx' });
    stage = 'mongodump/encryption';
    await dump(config, archive, key, { env, signal });
    await fsp.rm(config, { force: true });
    await verifyFile(archive, key, { signal });
    const sha256 = await hashFile(archive), size = (await fsp.stat(archive)).size;
    const date = new Date().toISOString();
    const object = `mongodb/${date.slice(0, 10).replaceAll('-', '/')}/${date.replaceAll(':', '-')}-${randomUUID()}.shfb`;
    const awsEnv = { ...minimalEnv(env), HOME: work, AWS_CONFIG_FILE: path.join(work, 'no-config'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(work, 'no-credentials'), AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: 'auto', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      AWS_MAX_ATTEMPTS: '3', AWS_RETRY_MODE: 'standard', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
    const aws = args => execute('aws', ['--endpoint-url', destination.endpoint, '--region', 'auto', ...args], { env: awsEnv, signal });
    const remote = `s3://${destination.bucket}/${object}`;
    stage = 'encrypted upload';
    await aws(['s3', 'cp', archive, remote, '--metadata', `sha256=${sha256}`, '--only-show-errors', '--no-progress']);
    stage = 'upload verification';
    const head = JSON.parse(await aws(['s3api', 'head-object', '--bucket', destination.bucket, '--key', object, '--output', 'json']));
    if (head.ContentLength !== size || head.Metadata?.sha256 !== sha256) throw new Error('Uploaded metadata mismatch');
    const downloaded = path.join(work, 'downloaded.shfb');
    await aws(['s3', 'cp', remote, downloaded, '--only-show-errors', '--no-progress']);
    if (await hashFile(downloaded) !== sha256) throw new Error('Uploaded bytes mismatch');
    await verifyFile(downloaded, key, { signal });
    // Object identity, ciphertext size and ciphertext hash contain no database content or credentials.
    return { object, bytes: size, sha256 };
  } catch { throw new Error(`Backup failed during ${stage}; service output suppressed to protect credentials.`); }
  finally {
    if (key) key.fill(0);
    const cleaned = await Promise.allSettled([work && fsp.rm(work, { recursive: true, force: true }), ram && fsp.rm(ram, { recursive: true, force: true })]);
    if (cleaned.some(result => result.status === 'rejected')) throw new Error('Backup temporary cleanup failed');
  }
}
if (require.main === module) {
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
  runBackup({ signal: controller.signal }).then(result => console.log(JSON.stringify({ status: 'encrypted-upload-verified', ...result })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { settings, quietCommand, dumpEncrypted, hashFile, runBackup };
