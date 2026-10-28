// Links an incident to code in the open workspace: commits in the window before it triggered,
// and files named in its alerts. Everything here is a suggestion, labelled as such in the pane.

import * as path from 'path';
import * as vscode from 'vscode';
import { Commit, Incident, IncidentDetail, LikelyFile, Slot, extractPaths, isCommitHash } from './model';

// The subset of the built-in Git extension's API (vscode.git, API v1) used here.
interface GitCommit {
  hash: string;
  message: string;
  authorName?: string;
  authorDate?: Date;
  commitDate?: Date;
}
interface GitChange {
  uri: vscode.Uri;
}
interface GitRepository {
  rootUri: vscode.Uri;
  log(options?: { maxEntries?: number; path?: string }): Promise<GitCommit[]>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}
interface GitAPI {
  repositories: GitRepository[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/.venv/**}';
const MAX_LIKELY = 15;
const MAX_COMMITS = 30;

async function gitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

export class CodeContext {
  constructor(private readonly mappingPaths: () => string[] | undefined) {}

  private windowHours(): number {
    return Math.max(1, vscode.workspace.getConfiguration('pagerduty').get<number>('changeWindowHours', 24));
  }

  async gather(incident: Incident, detail: IncidentDetail | undefined): Promise<{ commits: Slot<Commit>; likelyFiles: Slot<LikelyFile> }> {
    if (!vscode.workspace.isTrusted) {
      const unavailable = 'Code context is off in untrusted workspaces.';
      return { commits: { items: [], unavailable }, likelyFiles: { items: [], unavailable } };
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      const unavailable = 'Open the service’s repository to see related code.';
      return { commits: { items: [], unavailable }, likelyFiles: { items: [], unavailable } };
    }
    const commits = await this.commits(incident);
    const likelyFiles = await this.likelyFiles(detail, commits.items);
    return { commits, likelyFiles };
  }

  // Commits authored in [trigger - window, trigger], scoped to the mapping's paths when it has them.
  private async commits(incident: Incident): Promise<Slot<Commit>> {
    const git = await gitApi();
    if (!git || git.repositories.length === 0) return { items: [], unavailable: 'No Git repository open.' };
    const end = new Date(incident.createdAt).getTime();
    const start = end - this.windowHours() * 3600_000;
    const scopes = (this.mappingPaths() ?? []).map((p) => p.replace(/\/?\*\*.*$/, '').replace(/\/\*[^/]*$/, '')).filter(Boolean);

    const found = new Map<string, Commit>();
    for (const repo of git.repositories.slice(0, 3)) {
      const logs = scopes.length
        ? await Promise.all(scopes.map((s) => repo.log({ maxEntries: 200, path: path.join(repo.rootUri.fsPath, s) }).catch(() => [])))
        : [await repo.log({ maxEntries: 300 }).catch(() => [])];
      for (const c of logs.flat()) {
        const when = (c.authorDate ?? c.commitDate)?.getTime();
        if (when === undefined || when < start || when > end || found.has(c.hash)) continue;
        found.set(c.hash, {
          hash: c.hash,
          message: c.message.split('\n')[0],
          author: c.authorName ?? '',
          date: new Date(when).toISOString(),
          repoRoot: repo.rootUri.fsPath,
        });
      }
    }
    const items = [...found.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_COMMITS);
    return { items };
  }

  private async likelyFiles(detail: IncidentDetail | undefined, commits: Commit[]): Promise<Slot<LikelyFile>> {
    const out = new Map<string, LikelyFile>();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const label = (p: string) => path.relative(root, p) || p;

    // 1. Paths named in alert bodies, log entries and notes that resolve to workspace files.
    if (detail) {
      const text = [...detail.alerts.flatMap((a) => [a.summary, a.details ?? '']), ...detail.log.map((l) => l.summary), ...detail.notes.map((n) => n.content)].join('\n');
      for (const ref of extractPaths(text)) {
        if (out.size >= MAX_LIKELY) break;
        const base = path.posix.basename(ref.path);
        const hits = await vscode.workspace.findFiles(`**/${base}`, EXCLUDE, 20);
        const suffix = '/' + ref.path;
        const match = hits.find((u) => u.path.endsWith(suffix)) ?? (ref.path.includes('/') ? undefined : hits[0]);
        if (match && !out.has(match.fsPath)) {
          out.set(match.fsPath, { path: match.fsPath, label: label(match.fsPath), line: ref.line, reason: 'Named in the alert or timeline' });
        }
      }
    }

    // 2. Files touched by the most recent commits in the window.
    const git = await gitApi();
    if (git) {
      for (const c of commits.slice(0, 5)) {
        const repo = git.repositories.find((r) => r.rootUri.fsPath === c.repoRoot);
        const changes = await repo?.diffBetween(`${c.hash}~1`, c.hash).catch(() => []);
        for (const ch of changes ?? []) {
          if (out.size >= MAX_LIKELY) break;
          if (!out.has(ch.uri.fsPath)) {
            out.set(ch.uri.fsPath, { path: ch.uri.fsPath, label: label(ch.uri.fsPath), reason: `Changed in ${c.hash.slice(0, 7)} ${c.message}` });
          }
        }
      }
    }
    return { items: [...out.values()] };
  }
}

export async function openFile(fsPath: string, line?: number): Promise<void> {
  // Only open files inside the workspace; paths come from incident content. Normalise first so
  // "<workspace>/../elsewhere" can't pass the prefix check.
  const resolved = path.resolve(fsPath);
  const uri = vscode.Uri.file(resolved);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || !(resolved === folder.uri.fsPath || resolved.startsWith(folder.uri.fsPath + path.sep))) return;
  const pos = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
  await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, selection: pos ? new vscode.Range(pos, pos) : undefined });
}

// Picks a file changed in the commit and opens its diff.
export async function openCommit(hash: string, repoRoot: string): Promise<void> {
  // The hash reaches git as an argument: accept only a real object id, never something like "--output=…".
  if (!isCommitHash(hash)) return;
  const git = await gitApi();
  const repo = git?.repositories.find((r) => r.rootUri.fsPath === repoRoot);
  if (!git || !repo) return;
  const changes = await repo.diffBetween(`${hash}~1`, hash).catch(() => [] as GitChange[]);
  if (!changes.length) {
    void vscode.window.showInformationMessage(`No file changes to show for ${hash.slice(0, 7)}.`);
    return;
  }
  const pick =
    changes.length === 1
      ? { uri: changes[0].uri }
      : await vscode.window.showQuickPick(
          changes.map((c) => ({ label: path.basename(c.uri.fsPath), description: path.relative(repoRoot, path.dirname(c.uri.fsPath)), uri: c.uri })),
          { placeHolder: `Files changed in ${hash.slice(0, 7)}` },
        );
  if (!pick) return;
  const name = path.relative(repoRoot, pick.uri.fsPath);
  await vscode.commands.executeCommand(
    'vscode.diff',
    git.toGitUri(pick.uri, `${hash}~1`),
    git.toGitUri(pick.uri, hash),
    `${name} (${hash.slice(0, 7)})`,
    { viewColumn: vscode.ViewColumn.One },
  );
}
