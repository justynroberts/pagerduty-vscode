// Reads .pagerduty.json from the first workspace folder to find this repo's service.
// Untrusted workspaces never read it; the pagerduty.serviceId setting is the fallback.

import * as vscode from 'vscode';
import { Mapping, parseMapping } from './model';

const FILE = '.pagerduty.json';

export function watchMapping(onChange: (mapping: Mapping | undefined) => void, log: vscode.LogOutputChannel): vscode.Disposable {
  let lastError: string | undefined;

  const read = async () => {
    const id = vscode.workspace.getConfiguration('pagerduty').get<string>('serviceId', '').trim();
    const setting: Mapping | undefined = id ? { serviceId: id } : undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !vscode.workspace.isTrusted) return onChange(setting);

    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, FILE))).toString('utf8');
    } catch {
      lastError = undefined;
      return onChange(setting);
    }
    const { mapping, error } = parseMapping(text);
    if (error) {
      log.warn(error);
      // Show each distinct error once, not on every save.
      if (error !== lastError) {
        void vscode.window.showErrorMessage(error, 'Open .pagerduty.json').then((pick) => {
          if (pick) void vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, FILE));
        });
      }
      lastError = error;
      return onChange(setting);
    }
    lastError = undefined;
    onChange(mapping);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${FILE}`);
  const subs = [
    watcher,
    watcher.onDidCreate(read),
    watcher.onDidChange(read),
    watcher.onDidDelete(read),
    vscode.workspace.onDidChangeWorkspaceFolders(read),
    vscode.workspace.onDidGrantWorkspaceTrust(read),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pagerduty.serviceId')) void read();
    }),
  ];
  void read();
  return vscode.Disposable.from(...subs);
}
