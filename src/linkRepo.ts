// Writes .pagerduty.json for the open repository, after picking the service from PagerDuty.
// Offered once per folder after sign-in when no mapping exists, as the design doc describes.

import * as vscode from 'vscode';
import { PagerDutyClient } from './api';

const FILE = '.pagerduty.json';
const DISMISSED_KEY = 'pagerduty.linkRepo.dismissed';

export async function linkRepo(api: PagerDutyClient): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return void vscode.window.showInformationMessage('Open the repository folder first.');
  if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage('Trust this workspace to link it to a PagerDuty service.');

  const service = await pickService(api);
  if (!service) return;
  const scope = await vscode.window.showInputBox({
    title: `Link ${folder.name} to ${service.name}`,
    prompt: 'Optional: limit commits and likely files to part of a monorepo (comma-separated globs). Leave empty for the whole repo.',
    placeHolder: 'services/payments/**',
    ignoreFocusOut: true,
  });
  if (scope === undefined) return;
  const paths = scope
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const target = vscode.Uri.joinPath(folder.uri, FILE);
  const content = JSON.stringify({ serviceId: service.id, ...(paths.length ? { paths } : {}) }, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(target, Buffer.from(content));
  await vscode.window.showTextDocument(target, { preview: true });
  vscode.window.setStatusBarMessage(`$(link) Linked ${folder.name} to ${service.name}`, 4000);
}

function pickService(api: PagerDutyClient): Promise<{ id: string; name: string } | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
    qp.title = 'Which PagerDuty service is this repository?';
    qp.placeholder = 'Type to search services';
    let timer: NodeJS.Timeout | undefined;
    let seq = 0;
    const search = (q: string) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        qp.busy = true;
        try {
          const services = await api.searchServices(q);
          if (mine === seq) qp.items = services.map((s) => ({ label: s.name, description: s.id, id: s.id }));
        } catch (e) {
          qp.placeholder = `Search failed: ${(e as Error).message}`;
        } finally {
          if (mine === seq) qp.busy = false;
        }
      }, 250);
    };
    let done = false;
    qp.onDidChangeValue(search);
    qp.onDidAccept(() => {
      const s = qp.activeItems[0];
      if (!s) return;
      done = true;
      resolve({ id: s.id, name: s.label });
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!done) resolve(undefined);
    });
    search('');
    qp.show();
  });
}

// One gentle prompt per folder; "Don't ask again" is remembered.
export async function offerLinkRepo(ctx: vscode.ExtensionContext, hasMapping: boolean): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || hasMapping || !vscode.workspace.isTrusted) return;
  const dismissed = ctx.globalState.get<string[]>(DISMISSED_KEY, []);
  if (dismissed.includes(folder.uri.toString())) return;
  const pick = await vscode.window.showInformationMessage(
    `Link ${folder.name} to a PagerDuty service? You'll see who's on call, and incidents get commits and likely files from this repo.`,
    'Link',
    'Not now',
    "Don't ask again",
  );
  if (pick === 'Link') await vscode.commands.executeCommand('pagerduty.linkRepo');
  if (pick === "Don't ask again") await ctx.globalState.update(DISMISSED_KEY, [...dismissed, folder.uri.toString()]);
}
