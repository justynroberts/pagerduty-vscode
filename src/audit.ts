// Local record of every write the extension makes, as JSON lines in global storage.

import * as vscode from 'vscode';

export interface AuditEntry {
  at: string;
  incident: string;
  number: number;
  action: string;
  outcome: 'ok' | 'failed';
  error?: string;
}

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: vscode.Uri) {}

  get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, 'audit.jsonl');
  }

  record(entry: Omit<AuditEntry, 'at'>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    // Serialise writes so concurrent actions don't interleave a read-modify-write.
    this.queue = this.queue.then(async () => {
      await vscode.workspace.fs.createDirectory(this.dir);
      let existing: Uint8Array = new Uint8Array();
      try {
        existing = await vscode.workspace.fs.readFile(this.file);
      } catch {
        // First write.
      }
      await vscode.workspace.fs.writeFile(this.file, Buffer.concat([existing, Buffer.from(line)]));
    }).catch((e) => {
      // A failed write must not wedge the queue for later entries.
      console.error(`PagerDuty audit log write failed: ${(e as Error).message}`);
    });
  }

  async show(): Promise<void> {
    await this.queue;
    try {
      await vscode.workspace.fs.stat(this.file);
    } catch {
      void vscode.window.showInformationMessage('No actions recorded yet. Every acknowledge and resolve made from VS Code is logged here.');
      return;
    }
    await vscode.window.showTextDocument(this.file, { preview: true });
  }
}
