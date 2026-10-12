/** Installed through the file API, not an image change or a runtime-relative source file. */
export const execHelperPath = '/tmp/clanker-exec-v1.sh'
const execProgram = String.raw`const { openSync, readSync, writeSync, closeSync, writeFileSync, mkdirSync, readFileSync, constants } = await import('node:fs');
const [output, timeout, kind, ...args] = process.argv.slice(1);
const owner = output.slice('/tmp/clanker-'.length, -'.log'.length);
const stat = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
if (Number(stat[2]) !== process.pid || Number(stat[3]) !== process.pid) throw new Error('Command supervisor is not its group leader');
// The live leader pins this group identity. Native TERM fallback also reaps the entire group, never the leader alone.
const reap = () => process.kill(-process.pid, 'SIGKILL');
process.on('SIGTERM', reap);
// Reap while the leader is live, before the SDK's later leader-only SIGKILL deadline.
const deadline = setTimeout(() => { try { writeFileSync(output + '.status', owner + ':timeout', { mode: 0o600, flag: 'wx' }); } finally { reap(); } }, Number(timeout));
const io = output + '.io', files = [], drains = [];
let child, completed = false, failed = false, bytes = 0, status = 'helper_error', log;
async function drain(fd, destination) {
  const buffer = Buffer.alloc(65536);
  for (;;) {
    if (failed) return;
    let size;
    try { size = readSync(fd, buffer); } catch (error) { if (error.code !== 'EAGAIN') throw error; size = 0; }
    if (!size) {
      // All writes made before the user's exit are already in the FIFO. Orphan-held ends cannot keep us waiting.
      if (completed) return;
      await Bun.sleep(5); continue;
    }
    const data = buffer.subarray(0, Math.min(size, 128 * 1024 * 1024 - bytes));
    bytes += data.length;
    let written = 0;
    while (written < data.length) written += writeSync(log, data, written, data.length - written);
    await new Promise((resolve, reject) => destination.write(data, error => error ? reject(error) : resolve()));
    if (data.length < size) throw new Error('Command output exceeds 128 MiB');
  }
}
try {
  log = openSync(output, 'wx', 0o600);
  mkdirSync(io, { mode: 0o700 });
  const made = Bun.spawnSync(['/usr/bin/mkfifo', '-m', '600', io + '/stdout', io + '/stderr'], { stdout: 'ignore', stderr: 'ignore' });
  if (made.exitCode !== 0) throw new Error('Could not prepare command capture');
  const stdout = openSync(io + '/stdout', constants.O_RDONLY | constants.O_NONBLOCK);
  files.push(stdout);
  const stderr = openSync(io + '/stderr', constants.O_RDONLY | constants.O_NONBLOCK);
  files.push(stderr);
  const out = openSync(io + '/stdout', constants.O_WRONLY), err = openSync(io + '/stderr', constants.O_WRONLY);
  files.push(out, err);
  const command = kind === 'shell' ? ['/bin/bash', '-c', args[0]] : args;
  try { child = Bun.spawn(command, { stdin: 'inherit', stdout: out, stderr: err }); }
  catch { status = 'spawn_error'; throw new Error('Could not start requested program'); }
  closeSync(out); closeSync(err); files.splice(-2);
  const exited = child.exited.then(code => { completed = true; return code; });
  drains.push(drain(stdout, process.stdout), drain(stderr, process.stderr));
  await Promise.all(drains);
  status = 'done:' + await exited;
} catch (error) {
  failed = true;
  if (child) { if (child.exitCode === null) child.kill('SIGKILL'); status = 'done:1'; }
  await Promise.allSettled(drains);
  await new Promise((resolve, reject) => process.stderr.write(error.message + '\n', error => error ? reject(error) : resolve()));
} finally {
  clearTimeout(deadline);
  for (const fd of [...files, ...(log === undefined ? [] : [log])]) { try { closeSync(fd); } catch {} }
  // A missing/corrupt completion record is a visible adapter error, never a reason to replay the command.
  try { writeFileSync(output + '.status', owner + ':' + status, { mode: 0o600, flag: 'wx' }); } finally { reap(); }
}
`

export const execHelper = `#!/bin/bash
echo $$ > "$1" || exit 1
shift
exec bun -e '${execProgram.replaceAll("'", "'\\''")}' "$@"
`

// Scan only bounded process metadata. PID files are advisory garbage, never signal authority.
const cleanupProgram = String.raw`const { openSync, readSync, closeSync, opendirSync, rmSync } = await import('node:fs');
const [pidFile, output, keep] = process.argv.slice(1);
const expected = ${JSON.stringify(execProgram)};
function read(path, limit) {
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(limit);
  try { return buffer.subarray(0, readSync(fd, buffer)).toString(); } finally { closeSync(fd); }
}
function identity(pid) {
  const fields = read('/proc/' + pid + '/stat', 4096).split(') ')[1].split(' ');
  if (Number(fields[2]) !== pid || Number(fields[3]) !== pid) return;
  return fields[19];
}
const directory = opendirSync('/proc');
let visited = 0;
try { for (let entry; entry = directory.readSync();) {
  if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
  if (++visited > 4096) throw new Error('Too many processes to verify command cleanup');
  const pid = Number(entry.name);
  let matched = false;
  try {
    const start = identity(pid);
    if (!start) continue;
    const args = read('/proc/' + pid + '/cmdline', Buffer.byteLength(expected) + 1024).split('\0');
    const supervisor = args[1] === '-e' && args[2] === expected && args[3] === output;
    const bootstrap = args[1] === ${JSON.stringify(execHelperPath)} && args[2] === pidFile && args[3] === output;
    if (!supervisor && !bootstrap) continue;
    matched = true;
    if (identity(pid) !== start) throw new Error('Command supervisor identity changed during cleanup');
    process.kill(-pid, 'SIGKILL');
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code) && (matched || !['EACCES', 'EPERM'].includes(error.code))) throw error; }
} } finally { directory.closeSync(); }
rmSync(pidFile, { force: true });
rmSync(output + '.status', { force: true });
rmSync(output + '.io', { recursive: true, force: true });
if (keep !== 'keep') rmSync(output, { force: true });
`

/** Fixed host code remains usable after PID/helper files have been deleted, replaced or corrupted. */
export const cleanupScript = `exec bun -e '${cleanupProgram.replaceAll("'", "'\\''")}' "$@"`
