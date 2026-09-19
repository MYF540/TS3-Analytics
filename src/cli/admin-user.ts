/**
 * Manages web interface accounts.
 *
 *   pnpm admin:user create <name> [--role admin|moderator|viewer]   (default role: admin)
 *   pnpm admin:user password <name>
 *   pnpm admin:user disable <name>
 *   pnpm admin:user enable <name>
 *   pnpm admin:user list
 *
 * Passwords are asked for interactively (hidden) or read from stdin when piped.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  AccountError,
  createAdminUser,
  listAdminUsers,
  MIN_PASSWORD_LENGTH,
  setDisabled,
  setPassword,
} from '../api/auth/service.js';
import { loadConfigOrExit } from '../config/config.js';
import { openDatabase, runMigrations } from '../db/client.js';
import { ADMIN_ROLES, type AdminRole } from '../db/schema.js';

function readLineHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo nothing while the password is typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (text) => {
      if (text.includes(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

async function askPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  console.log(`Mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen.`);
  const first = await readLineHidden('Passwort: ');
  const second = await readLineHidden('Passwort wiederholen: ');
  if (first !== second) {
    console.error('Die Passwörter stimmen nicht überein.');
    process.exit(2);
  }
  return first;
}

const ERROR_TEXT: Record<AccountError['code'], string> = {
  INVALID_USERNAME: 'Ungültiger Name: 3–32 Zeichen, erlaubt sind Buchstaben, Ziffern, "." "_" "-".',
  WEAK_PASSWORD: `Das Passwort muss mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen lang sein.`,
  USERNAME_TAKEN: 'Diesen Namen gibt es bereits.',
  UNKNOWN_USER: 'Dieses Konto gibt es nicht.',
};

function usage(): never {
  console.error(
    'Verwendung: pnpm admin:user create <name> [--role admin|moderator|viewer] | password <name> | disable <name> | enable <name> | list',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { role: { type: 'string', default: 'admin' } },
    strict: true,
  });
  const [command, name] = positionals;
  if (!command) usage();

  const config = loadConfigOrExit();
  const database = openDatabase(config.database);
  try {
    runMigrations(database);
    const now = Math.floor(Date.now() / 1000);
    switch (command) {
      case 'create': {
        if (!name) usage();
        if (!(ADMIN_ROLES as readonly string[]).includes(values.role)) usage();
        const user = await createAdminUser(
          database.db,
          { username: name, password: await askPassword(), role: values.role as AdminRole },
          now,
        );
        console.log(`Konto "${user.username}" mit Rolle ${user.role} angelegt.`);
        break;
      }
      case 'password':
        if (!name) usage();
        await setPassword(database.db, name, await askPassword());
        console.log('Passwort geändert, alle Sitzungen dieses Kontos wurden beendet.');
        break;
      case 'disable':
      case 'enable':
        if (!name) usage();
        setDisabled(database.db, name, command === 'disable');
        console.log(command === 'disable' ? 'Konto gesperrt.' : 'Konto entsperrt.');
        break;
      case 'list':
        for (const u of listAdminUsers(database.db)) {
          const last = u.lastLoginAt ? new Date(u.lastLoginAt * 1000).toISOString() : 'nie';
          console.log(
            `${u.username.padEnd(24)} ${u.role.padEnd(10)} ${u.disabled ? 'gesperrt' : 'aktiv   '} letzter Login: ${last}`,
          );
        }
        break;
      default:
        usage();
    }
  } catch (error) {
    if (error instanceof AccountError) {
      console.error(ERROR_TEXT[error.code]);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    database.close();
  }
}

void main();
