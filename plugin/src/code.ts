/// <reference types="@figma/plugin-typings" />
// Figma Lens plugin (Figma desktop app). Reads the selected frame(s) with the shared core and hands
// every file to the plugin UI (ui.html), which uploads it to the local bridge (bridge/server.js).
// The bridge writes design/<frame>/ for Claude Code to read. No REST API, no Dev Mode needed.
// figma.com in a browser can't load development plugins: there, use `figma-lens browser` (plugin/src/page.ts).

import { exportNode, normalizeOptions, errMsg } from './core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function sendSelection(): void {
  figma.ui.postMessage({
    type: 'selection',
    items: figma.currentPage.selection.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      w: Math.round(n.width),
      h: Math.round(n.height),
    })),
  });
}

figma.showUI(__html__, { width: 340, height: 480, themeColors: true });
figma.on('selectionchange', sendSelection);
sendSelection();

figma.ui.onmessage = async (msg: Json) => {
  if (!msg || msg.type !== 'export') return;
  const opts = normalizeOptions(msg.options);
  const selection = figma.currentPage.selection.slice();
  if (!selection.length) {
    figma.ui.postMessage({ type: 'error', message: 'Select at least one frame first.' });
  }
  for (const node of selection) {
    const exportId = node.id + '@' + Date.now();
    figma.ui.postMessage({ type: 'begin', exportId, name: node.name });
    // Each file goes to the UI in its own message as soon as it exists; the UI uploads it right away.
    const sink = {
      file: (path: string, bytes: Uint8Array): void => figma.ui.postMessage({ type: 'file', exportId, path, bytes }),
      progress: (text: string): void => figma.ui.postMessage({ type: 'progress', text }),
    };
    try {
      const payload = await exportNode(node, opts, sink);
      figma.ui.postMessage({ type: 'payload', exportId, payload });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', exportId, message: node.name + ': ' + errMsg(e) });
    }
  }
  figma.ui.postMessage({ type: 'done-reading', count: selection.length });
};
