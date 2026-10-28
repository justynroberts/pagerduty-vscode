// Registers PagerDuty's official remote MCP server with the editor's agent chat, using the same
// sign-in as the extension. Same auth, same permissions as the GUI. Editors without the
// MCP provider API (older VS Code, some forks) skip this silently.

import * as vscode from 'vscode';
import { Credentials } from './api';

const MCP_URL = 'https://mcp.pagerduty.com/mcp';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerMcp(getCredentials: () => Promise<Credentials | undefined>, onAuthChange: vscode.Event<void>, log: vscode.LogOutputChannel): vscode.Disposable | undefined {
  const lm = vscode.lm as any;
  const HttpDef = (vscode as any).McpHttpServerDefinition;
  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function' || typeof HttpDef !== 'function') {
    log.info('This editor has no MCP provider API; skipping the PagerDuty MCP server.');
    return undefined;
  }
  const changed = new vscode.EventEmitter<void>();
  const enabled = () => vscode.workspace.getConfiguration('pagerduty').get<boolean>('agentTools', true);

  const provider = {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      if (!enabled() || !(await getCredentials())) return [];
      return [new HttpDef('PagerDuty', vscode.Uri.parse(MCP_URL), {}, '1')];
    },
    // The token is attached only when the server starts, never stored in the definition list.
    async resolveMcpServerDefinition(def: any) {
      const c = await getCredentials();
      if (!c) return undefined;
      def.headers = { Authorization: c.kind === 'oauth' ? `Bearer ${c.accessToken}` : `Token token=${c.accessToken}` };
      return def;
    },
  };

  return vscode.Disposable.from(
    changed,
    lm.registerMcpServerDefinitionProvider('pagerduty.mcp', provider),
    onAuthChange(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pagerduty.agentTools')) changed.fire();
    }),
  );
}
