// The screen map: how the exported screens connect, built from the Figma prototype links that every
// export records in meta.prototype (and in its .figma-lens.json marker). Written next to INDEX.md as
// FLOWS.md (for Claude and people) and flows.json (for tools), after every export, from the markers
// alone, so no spec.json has to be read.
import { actionStr, triggerStr } from './render-md.js';

// Links that move to another screen. SCROLL_TO stays inside a screen; CHANGE_TO swaps a component variant.
const SCREEN_NAV = new Set(['NAVIGATE', 'SWAP', 'OVERLAY']);

const fileOf = (m) => m.fileKey || m.file || '?';
const keyOf = (file, id) => `${file}#${id}`;
const q = (s) => JSON.stringify(String(s));
// Names come from the designer: a | would split a table cell.
const cell = (s) => String(s).replace(/\|/g, '\\|');

/**
 * The desktop plugin can't read the file key (figma.fileKey needs a private plugin); browser exports
 * have it. Give a key-less export the key of another export from the same file name, so one frame
 * exported by both tools is one screen, not two.
 */
function withFileKeys(rows) {
  const keys = new Map();
  for (const r of rows) {
    if (!r.fileKey || !r.file) continue;
    const k = keys.get(r.file);
    keys.set(r.file, k === undefined || k === r.fileKey ? r.fileKey : null); // two files with one name: don't guess
  }
  return rows.map((r) => (r.fileKey || !keys.get(r.file) ? r : { ...r, fileKey: keys.get(r.file) }));
}

/** https://www.figma.com/design/<key>/?node-id=12-34 (Figma ignores the name part of the path). */
export function figmaLink(fileKey, nodeId) {
  return fileKey ? `https://www.figma.com/design/${fileKey}/?node-id=${String(nodeId).replace(/:/g, '-')}` : null;
}

/**
 * The other screens one export links to (for `figma-lens browser --flow`): [{ id, name, overlay }].
 * Same rule as the screen map: navigate / replace / overlay to a node outside this screen.
 */
export function screenTargets(prototype) {
  const p = prototype || {};
  const dest = new Map((p.destinations || []).map((d) => [d.id, d]));
  const out = [];
  for (const l of p.links || []) {
    const d = l.to && dest.get(l.to);
    if (l.type !== 'NODE' || !d || d.inside || d.missing || !SCREEN_NAV.has(l.navigation)) continue;
    if (!out.some((t) => t.id === l.to)) out.push({ id: l.to, name: d.name, overlay: l.navigation === 'OVERLAY' });
  }
  return out;
}

/**
 * rows: [{ dir, ...marker }] for every export in the folder.
 * Returns { screens, links, missing, starts } (flows.json).
 */
export function buildFlows(rows) {
  rows = withFileKeys(rows);
  const screens = rows.map((r) => ({
    key: keyOf(fileOf(r), r.nodeId),
    id: r.nodeId,
    name: r.nodeName,
    dir: r.dir,
    file: r.file,
    fileKey: r.fileKey || null,
    page: r.page,
    size: `${r.width}×${r.height}`,
    scrolls: (r.prototype && r.prototype.screen && r.prototype.screen.scrolls) || null,
    fixedChildren: (r.prototype && r.prototype.screen && r.prototype.screen.fixedChildren) || 0,
  }));
  const byKey = new Map(screens.map((s) => [s.key, s]));

  const links = [];
  const missing = new Map(); // key → { id, name, page, file, fileKey, overlay, from: Set }
  const starts = [];
  for (const r of rows) {
    const p = r.prototype || {};
    const file = fileOf(r);
    const from = byKey.get(keyOf(file, r.nodeId));
    for (const f of p.flows || []) {
      if (!starts.some((s) => s.key === keyOf(file, f.start))) starts.push({ key: keyOf(file, f.start), flow: f.name, id: f.start, file: r.file, page: r.page });
    }
    const dest = new Map((p.destinations || []).map((d) => [d.id, d]));
    for (const l of p.links || []) {
      const d = l.to ? dest.get(l.to) : null;
      const e = {
        from: from.key,
        layer: l.layer,
        layerName: l.layerName,
        trigger: l.trigger,
        type: l.type,
        navigation: l.navigation || null,
        to: null,
        toId: l.to || null,
        toName: l.toName || (d && d.name) || null,
        text: actionStr(l),
      };
      if (l.conditional) e.conditional = true;
      if (l.url) e.url = l.url;
      if (l.type === 'NODE' && l.to && d && !d.inside && !d.missing && SCREEN_NAV.has(l.navigation)) {
        e.to = keyOf(file, l.to);
        if (!byKey.has(e.to)) {
          const m = missing.get(e.to) || { key: e.to, id: l.to, name: d.name, page: d.page, file: r.file, fileKey: r.fileKey || null, overlay: false, from: new Set() };
          if (l.navigation === 'OVERLAY') m.overlay = true;
          m.from.add(from.name);
          missing.set(e.to, m);
        }
      }
      links.push(e);
    }
  }
  return {
    screens,
    links,
    missing: [...missing.values()].map((m) => ({ ...m, from: [...m.from], link: figmaLink(m.fileKey, m.id) })),
    starts: starts.map((s) => ({ ...s, exported: byKey.has(s.key) })),
  };
}

function mermaidId(key, ids) {
  if (!ids.has(key)) ids.set(key, 's' + ids.size);
  return ids.get(key);
}

const label = (s) => String(s).replace(/["[\]{}()<>|#;`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '?';

export function renderFlowsMd(flows) {
  const { screens, links, missing, starts } = flows;
  const byKey = new Map(screens.map((s) => [s.key, s]));
  const name = (key) => (byKey.get(key) ? byKey.get(key).name : (missing.find((m) => m.key === key) || {}).name || key);
  const out = [
    '# Screen map (figma-lens)',
    '',
    'How the exported screens connect, from the Figma prototype. Build the navigation from this file: every',
    'link below is a real interaction in the design. Each screen\'s `spec.md` shows the same links under the',
    'layer that triggers them (lines starting with `→`).',
    '',
  ];
  const screenLinks = links.filter((l) => l.to);
  if (!links.length && !starts.length) {
    out.push('No prototype links in the exported screens. If the app has navigation, ask the designer to add it in');
    out.push('Figma (Prototype tab), or wire it from the product spec.');
    out.push('');
    return out.join('\n');
  }

  if (starts.length) {
    out.push('## Start screens (Figma flows)');
    for (const s of starts) {
      const sc = byKey.get(s.key);
      out.push(`- Flow ${q(s.flow)} starts at ${sc ? `${q(sc.name)} → \`${sc.dir}/\`` : `\`${s.id}\` (not exported yet)`}`);
    }
    out.push('');
  }

  out.push('## Screens');
  out.push('| Screen | Folder | Size | Scroll | Goes to | Comes from |');
  out.push('|---|---|---|---|---|---|');
  for (const s of screens) {
    const to = [...new Set(screenLinks.filter((l) => l.from === s.key).map((l) => name(l.to)))];
    const fromS = [...new Set(screenLinks.filter((l) => l.to === s.key).map((l) => name(l.from)))];
    const scroll = s.scrolls ? s.scrolls.toLowerCase() + (s.fixedChildren ? `, ${s.fixedChildren} fixed` : '') : '—';
    out.push(`| ${cell(s.name)} | \`${cell(s.dir)}/\` | ${s.size} | ${scroll} | ${cell(to.join(', ')) || '—'} | ${cell(fromS.join(', ')) || '—'} |`);
  }
  out.push('');

  out.push('## Links');
  out.push('| From screen | Layer | Trigger | Action |');
  out.push('|---|---|---|---|');
  for (const l of links) {
    const target = l.to && byKey.has(l.to) ? ` → \`${byKey.get(l.to).dir}/\`` : l.to ? ' → **not exported**' : '';
    out.push(`| ${cell(name(l.from))} | ${cell(q(l.layerName))} \`${l.layer}\` | ${triggerStr(l.trigger ? { type: l.trigger } : null)} | ${l.conditional ? '(if/else branch) ' : ''}${cell(l.text)}${cell(target)} |`);
  }
  out.push('');

  if (missing.length) {
    out.push('## Not exported yet');
    out.push('These screens are linked from exported screens but are not in this folder. Export them so the whole flow');
    out.push('can be built (or add `--flow` to export a screen and everything it links to):');
    for (const m of missing) {
      out.push(`- ${q(m.name)} \`${m.id}\`${m.overlay ? ' (overlay)' : ''}, page ${q(m.page || '?')}, linked from ${m.from.map(q).join(', ')}${m.link ? `: \`figma-lens browser "${m.link}" --once\`` : ''}`);
    }
    out.push('');
  }

  if (screenLinks.length) {
    const ids = new Map();
    out.push('## Graph');
    out.push('```mermaid');
    out.push('flowchart LR');
    for (const s of screens) out.push(`  ${mermaidId(s.key, ids)}["${label(s.name)}"]`);
    for (const m of missing) out.push(`  ${mermaidId(m.key, ids)}["${label(m.name)} (not exported)"]:::missing`);
    const seen = new Set();
    for (const l of screenLinks) {
      const arrow = l.navigation === 'OVERLAY' ? '-.->' : '-->';
      const line = `  ${mermaidId(l.from, ids)} ${arrow}|${label(l.layerName)}| ${mermaidId(l.to, ids)}`;
      if (!seen.has(line)) out.push(line);
      seen.add(line);
    }
    if (missing.length) out.push('  classDef missing stroke-dasharray: 4 4');
    out.push('```');
    out.push('Solid arrow = navigate / replace, dotted = opens as overlay.');
    out.push('');
  }
  return out.join('\n');
}
