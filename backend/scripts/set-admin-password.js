'use strict';

require('dotenv').config();
const bcrypt   = require('bcryptjs');
const Database = require('better-sqlite3');
const path     = require('path');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/set-admin-password.js <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || './db/metaregistry.sqlite';
const db = new Database(path.resolve(DB_PATH));

const hash = bcrypt.hashSync(password, 12);
db.prepare('INSERT OR REPLACE INTO admin_config (key, value) VALUES (?, ?)').run('password_hash', hash);
console.log('Admin password set successfully.');
db.close();
