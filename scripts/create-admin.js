'use strict';
require('dotenv').config({ quiet: true });
const readline = require('node:readline/promises');
const db = require('../src/db');
const { hashPassword, generatePublicKey } = require('../src/lib/security');
const { validateUsername, validateEmail, validatePassword } = require('../src/lib/validators');

function parseCliArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inlineVal] = arg.slice(2).split('=');
      if (inlineVal !== undefined) {
        flags[key] = inlineVal;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return {
    username: flags.username || positional[0] || '',
    email: flags.email || positional[1] || '',
    password: flags.password || positional[2] || ''
  };
}

async function main() {
  await db.migrate();
  const args = parseCliArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rawUser = args.username || (await rl.question('Admin username (e.g. founder): '));
    const rawEmail = args.email || (await rl.question('Admin email (e.g. admin@socialadlinker.com): '));
    const rawPass = args.password || (await rl.question('Admin password (min 8 chars, letters + numbers): '));

    const username = validateUsername(rawUser);
    const email = validateEmail(rawEmail);
    const password = validatePassword(rawPass);
    const hash = await hashPassword(password);

    const existing = await db.one('SELECT id, username FROM users WHERE lower(email) = $1 OR lower(username) = $2', [email, username]);
    if (existing) {
      await db.query(
        `UPDATE users SET role = 'admin', status = 'active', password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1`,
        [existing.id, hash]
      );
      console.log(`Updated existing user "${existing.username}" to admin.`);
    } else {
      await db.query(
        `INSERT INTO users (username, email, password_hash, full_name, role, public_key, default_price_rupees)
         VALUES ($1, $2, $3, 'Platform Administrator', 'admin', $4, 1)`,
        [username, email, hash, generatePublicKey()]
      );
      console.log(`Created new admin account: ${username} (${email})`);
    }
  } finally {
    rl.close();
    await db.close();
  }
}

main().catch((err) => {
  console.error('Error creating admin:', err.message);
  process.exit(1);
});

