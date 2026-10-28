// Read-only run of the extension in real VS Code against a live account.
//   PD_TOKEN=... [PD_USER_EMAIL=you@company.com for account-level keys] npm run test:real
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { PD_TOKEN, PD_USER_EMAIL } = process.env;
if (!PD_TOKEN) throw new Error('Set PD_TOKEN');

// Account-level keys need an acting user, as at sign-in.
const headers = { Accept: 'application/vnd.pagerduty+json;version=2', Authorization: `Token token=${PD_TOKEN}` };
let env = { PD_TOKEN };
const meRes = await fetch('https://api.pagerduty.com/users/me', { headers });
if (meRes.status === 400) {
  const r = await (await fetch(`https://api.pagerduty.com/users?query=${encodeURIComponent(PD_USER_EMAIL ?? '')}&limit=5`, { headers })).json();
  const u = r.users.find((x) => !PD_USER_EMAIL || x.email.toLowerCase() === PD_USER_EMAIL.toLowerCase());
  if (!u) throw new Error('Account-level key: set PD_USER_EMAIL to your PagerDuty login');
  console.log(`Account-level key; acting as ${u.name}`);
  env = { ...env, PD_USER_ID: u.id, PD_USER_EMAIL: u.email };
}

const local = ['/Applications/Visual Studio Code.app/Contents/MacOS/Code'].find(existsSync);
const userData = mkdtempSync('/tmp/pdvs-');
let code = 1;
try {
  code = await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || local,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test/e2e/real-suite.cjs'),
    launchArgs: [root, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`],
    extensionTestsEnv: env,
  });
} catch (e) {
  console.error('Real run failed:', e.message ?? e);
} finally {
  rmSync(userData, { recursive: true, force: true });
}
process.exit(code);
