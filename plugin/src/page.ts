/// <reference types="@figma/plugin-typings" />
// figma-lens browser: this bundle (plugin/dist/page.js) is injected by the figma-lens CLI into an
// open figma.com design file (Chrome/Edge/Chromium, any OS) and reads frames with the same core as the
// desktop plugin, using the `figma` object that figma.com exposes on the page. No plugin, no
// desktop app, no network: everything goes back to the CLI through one function the CLI exposes on
// the page (Playwright exposeFunction), one call per file, so no single message carries a whole export.
//
// The figma object on the page is NOT a documented Figma API. If it is missing, the CLI says so and
// the desktop plugin is the fallback.

import { exportNode, normalizeOptions, errMsg, VERSION } from './core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Send = (kind: string, exportId: string | null, a?: string, b?: string) => Promise<unknown>;
declare function btoa(data: string): string; // the page is a browser; the project has no DOM typings

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

/** For `figma-lens project`: where the prototype starts, and every top-level screen on the page. Never throws. */
function pageScreens(): Json {
  const out: Json = { flows: [], frames: [] };
  try {
    out.flows = (figma.currentPage.flowStartingPoints || []).map((f) => ({ id: f.nodeId, name: f.name }));
  } catch {
    // older page API: no flows
  }
  try {
    // Screens are top-level frames, also inside Sections (common in newer files). Components on the
    // page are design-system parts, not screens. Positions are absolute: frames in a section have
    // section-relative x/y.
    const walk = (nodes: readonly SceneNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'SECTION') walk(n.children);
        else if (n.type === 'FRAME') {
          const box = n.absoluteBoundingBox || { x: n.x, y: n.y, width: n.width, height: n.height };
          out.frames.push({ id: n.id, name: n.name, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) });
        }
      }
    };
    walk(figma.currentPage.children || []);
  } catch {
    // page not loaded
  }
  return out;
}

function status(): Json {
  const g = globalThis as Json;
  if (typeof g.figma !== 'object' || !g.figma) return { ok: false, reason: 'no-figma' };
  try {
    return {
      ok: true,
      version: VERSION,
      editorType: figma.editorType,
      file: figma.root.name,
      page: figma.currentPage.name,
      selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type, w: Math.round(n.width), h: Math.round(n.height) })),
      ...pageScreens(),
    };
  } catch (e) {
    return { ok: false, reason: 'not-ready', message: errMsg(e) };
  }
}

/**
 * Export the given node ids (or, with none, the current selection). Everything is delivered through
 * `send` (the CLI's exposed function, by name); the return value is only a short summary.
 */
async function exportNodes(ids: string[] | null, rawOptions: Json, sendName: string): Promise<Json> {
  const send = (globalThis as Json)[sendName] as Send;
  if (typeof send !== 'function') return { ok: false, errors: ['figma-lens: delivery function ' + sendName + ' is missing'], exports: [] };
  const opts = normalizeOptions(rawOptions);
  const nodes: SceneNode[] = [];
  const errors: string[] = [];
  // null = the selection. A list (even an empty one) is never replaced by the selection.
  if (ids) {
    if (!ids.length) errors.push('no frame ids given');
    for (const id of ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (!n) errors.push('node ' + id + ' not found in this file');
      else if (n.type === 'DOCUMENT' || n.type === 'PAGE') errors.push('node ' + id + ' is a ' + n.type.toLowerCase() + ', not a frame');
      else nodes.push(n as SceneNode);
    }
  } else {
    nodes.push(...figma.currentPage.selection);
  }
  if (!nodes.length && !errors.length) errors.push('nothing selected: select one or more frames in Figma, or pass a Figma link with ?node-id=');

  const done: Json[] = [];
  for (const node of nodes) {
    const exportId = node.id + '@' + Date.now();
    const pending: Promise<unknown>[] = [];
    const sink = {
      file: (path: string, bytes: Uint8Array): void => {
        pending.push(send('file', exportId, path, toBase64(bytes)));
      },
      progress: (text: string): void => {
        pending.push(send('progress', exportId, text));
      },
    };
    try {
      let page: BaseNode | null = node;
      while (page && page.type !== 'PAGE') page = page.parent;
      // A frame on another page (export by link, --flow): load that page before reading it.
      if (page && page !== figma.currentPage && typeof (page as PageNode).loadAsync === 'function') await (page as PageNode).loadAsync();
      const info = { name: node.name, id: node.id, type: node.type, w: Math.round(node.width), h: Math.round(node.height), page: page ? page.name : '?' };
      await send('begin', exportId, JSON.stringify(info));
      const payload = await exportNode(node, opts, sink);
      await Promise.all(pending); // every file is with the CLI before it gets the spec
      await send('payload', exportId, JSON.stringify(payload));
      done.push({ exportId, name: node.name, ok: true });
    } catch (e) {
      await Promise.all(pending).catch(() => undefined);
      await send('error', exportId, node.name + ': ' + errMsg(e)).catch(() => undefined);
      done.push({ exportId, name: node.name, ok: false, error: errMsg(e) });
    }
  }
  return { ok: errors.length === 0, errors, exports: done };
}

(globalThis as Json).__figmaLens = { version: VERSION, status, exportNodes };
