// Same as make-password.html, for the command line:  node tools/make-password.mjs jane
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const user = (process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9._-]+$/.test(user)) { console.error('Usage: node tools/make-password.mjs <username>'); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Password (12+ characters): ', (pass) => {
  rl.close();
  if (pass.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
  const iterations = 600000, salt = randomBytes(16);
  const hash = pbkdf2Sync(pass, salt, iterations, 32, 'sha256');
  console.log(`\n${user}:${iterations}:${salt.toString('hex')}:${hash.toString('hex')}`);
});
