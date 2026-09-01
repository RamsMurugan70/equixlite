// Creates the first admin account.
//
// Bootstrapping problem: the admin API needs an admin to call it, and there isn't one yet. This
// runs at the console, where being able to run it already implies control of the machine, so it
// grants nothing that shell access did not.
//
// It refuses to run once an admin exists. Otherwise it would be a permanent unauthenticated
// route to a privileged account for anyone who reaches the filesystem.
const readline = require('readline');
const users = require('../repositories/userRepository');
const { checkPasswordStrength } = require('../services/auth/passwords');

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
    // Suppress echo so the password is not left on screen or in scrollback.
    process.stdout.write(question);
    const onData = (ch) => {
      if (['\n', '\r', ''].includes(String(ch))) process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
    rl._writeToOutput = (s) => { if (!s.includes(question)) return; rl.output.write(question); };
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

(async () => {
  const existing = await users.listUsers();
  if (existing.some((u) => u.role === 'admin')) {
    console.error('\n  An admin account already exists. Use the admin console to add more.\n');
    process.exit(1);
  }

  console.log('\n  EquixLite — create the first admin\n');
  const loginId = await ask('  Login ID: ');
  const displayName = await ask('  Display name: ');
  const password = await ask('  Password (min 12 chars, not echoed): ', { hidden: true });

  const weak = checkPasswordStrength(password);
  if (weak) { console.error(`\n  ${weak}\n`); process.exit(1); }

  const user = await users.createUser({ loginId, displayName, password, role: 'admin' });
  // Cleared immediately: this password was chosen by its owner, not issued to them, so the
  // force-change that protects handed-out credentials would just be an annoyance here.
  await users.setPassword(user.id, password, { mustChange: false });
  await users.audit({ userId: user.id, actorId: user.id, action: 'user.created',
    detail: 'first admin, via createAdmin script' });

  console.log(`\n  Created admin "${user.loginId}". Start the server and sign in.\n`);
  process.exit(0);
})().catch((e) => { console.error(`\n  ${e.message}\n`); process.exit(1); });
