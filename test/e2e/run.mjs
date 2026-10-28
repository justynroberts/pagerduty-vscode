// End-to-end: launches VS Code with the extension against a mock PagerDuty API and the real relay.
// Uses a local VS Code when one is found (or VSCODE_EXECUTABLE), otherwise downloads one.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { createRelay } from '../../relay/server.mjs';
import { createMockPagerDuty } from './mock-pagerduty.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

const mock = createMockPagerDuty();
const relay = createRelay({ webhookSecret: 'e2e-secret', clientToken: 'e2e-relay-token', log: () => {} });
const [mockUrl, relayUrl] = await Promise.all([listen(mock.server), listen(relay.server)]);

const local = ['/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].find(existsSync);
// Short path: the IPC socket path inside user-data-dir must stay under ~100 chars on macOS.
const userData = mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : '/tmp', 'pdvs-'));

let code = 1;
try {
  code = await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || local,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test/e2e/suite.cjs'),
    launchArgs: [root, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { MOCK_URL: mockUrl, RELAY_URL: relayUrl, RELAY_TOKEN: 'e2e-relay-token', WEBHOOK_SECRET: 'e2e-secret' },
  });
} catch (e) {
  console.error('E2E failed:', e.message ?? e);
} finally {
  for (const c of relay.clients) c.end();
  relay.server.close();
  mock.server.close();
  rmSync(userData, { recursive: true, force: true });
}
process.exit(code);
