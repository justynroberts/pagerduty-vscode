// Bundles the extension host (Node, CommonJS) and the incident pane (browser, IIFE).
// Everything ships inside dist/, so the .vsix has no runtime node_modules.
import * as esbuild from 'esbuild';
import { rmSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// Release builds start clean so stale dev source maps never reach the .vsix.
if (production) rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.tsx'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
