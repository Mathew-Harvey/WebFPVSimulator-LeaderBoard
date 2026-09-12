/*
 * admin-hash.js: mint one line of BOARD_ADMINS.
 *
 * An admin of the board is an address and a password, and the board stores
 * the password as an scrypt hash. This prints the line that says so, which
 * is then pasted into BOARD_ADMINS on the host.
 *
 *   node scripts/admin-hash.js someone@example.com
 *
 * It asks for the password twice and does not echo it, so the word itself
 * never reaches a shell history, a process list or a scrollback. Piping
 * works too, for a script:
 *
 *   printf '%s' "$PASSWORD" | node scripts/admin-hash.js someone@example.com
 *
 * BOARD_ADMINS takes several of these, separated by commas or newlines, and
 * REPLACES the built-in list rather than adding to it. See src/admin.js.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { normaliseEmail, PASSWORD_MIN, PASSWORD_MAX } from '../src/admin.js';

const N = 16384;
const r = 8;
const p = 1;

const email = normaliseEmail(process.argv[2]);
if (!email) {
  console.error('Usage: node scripts/admin-hash.js someone@example.com');
  console.error('The address is the one they will type into the board\'s Admin panel.');
  process.exit(2);
}

/* Typed, with the terminal's echo off. readline's own `output` is what
 * writes the characters back, so muting the write is what hides them. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = rl.output.write.bind(rl.output);
    rl.output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
    rl.question(prompt, (answer) => {
      rl.output.write = write;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

/* Piped, one password and no prompt. */
function readPiped() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text.replace(/\r?\n$/, '')));
  });
}

let password;
if (process.stdin.isTTY) {
  password = await askHidden('Password: ');
  const again = await askHidden('Again: ');
  if (password !== again) {
    console.error('Those did not match. Nothing written.');
    process.exit(1);
  }
} else {
  password = await readPiped();
}

if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
  console.error(`A password here is ${PASSWORD_MIN} to ${PASSWORD_MAX} characters. Nothing written.`);
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N, r, p });
console.log(`${email}:scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`);
