// Makes an AUTH_USERS entry for the built-in sign-in:
//
//   node src/hash-password.ts you@example.com      prints  you@example.com:scrypt.…
//   node src/hash-password.ts                      prints  scrypt.…  (only the hash)
//
// The password is never an argument (it would land in the shell history and the process list). On
// a terminal the command asks for it twice, without echo. From a pipe it reads the first line of
// stdin. Prompts and warnings go to stderr, so stdout is only the entry.
//
// It imports nothing outside src/, so it runs in the Docker image (only src/, node_modules/ and
// package.json exist there): docker run --rm -it <image> node src/hash-password.ts you@example.com

import { hashPassword, passwordProblem } from './core/passwords.ts';

const MIN_RECOMMENDED = 12;

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let line = '';
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(line);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled'));
        if (char === '\u007f' || char === '\b') line = [...line].slice(0, -1).join('');
        else if (char >= ' ') line += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** The first line of stdin, for a pipe. */
async function readFirstLine(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes('\n')) break;
  }
  const end = text.search(/\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0] === '-h' || args[0] === '--help') {
    process.stderr.write(
      'Usage: node src/hash-password.ts [email]\n' +
        'Reads the password from the terminal (asked twice) or, from a pipe, the first line of stdin.\n',
    );
    return args.length > 1 ? 1 : 0;
  }
  const email = args[0]?.trim().toLowerCase();
  if (email !== undefined && (email === '' || /[\s,:]/.test(email))) {
    process.stderr.write('The email must not be empty or contain spaces, commas or colons.\n');
    return 1;
  }

  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden('Password: ');
    if (!password) {
      process.stderr.write('The password is empty.\n');
      return 1;
    }
    if ((await promptHidden('Password again: ')) !== password) {
      process.stderr.write('The two passwords differ.\n');
      return 1;
    }
  } else {
    password = await readFirstLine();
  }

  const problem = passwordProblem(password);
  if (problem) {
    process.stderr.write(`${problem}.\n`);
    return 1;
  }
  if ([...password].length < MIN_RECOMMENDED) {
    process.stderr.write(
      `Warning: the password is shorter than ${MIN_RECOMMENDED} characters. A longer one is safer.\n`,
    );
  }

  const hash = await hashPassword(password);
  process.stdout.write(`${email ? `${email}:` : ''}${hash}\n`);
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  // Ctrl-C at the prompt, or a terminal that cannot hide the input: one line, no stack trace.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
