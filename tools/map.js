// Component map: ties Figma components and variables to the project's real code, so the agent
// reuses existing widgets/tokens instead of rebuilding them.
//
// figma-lens.map.json (at the project root):
// {
//   "components": {
//     "Button": { "flutter": "lib/widgets/app_button.dart#AppButton", "web": "src/components/Button.tsx#Button",
//                 "props": { "Label": "label", "Type": "variant" } },
//     "Icon/*": "SvgPicture.asset('assets/icons/<name>.svg')"
//   },
//   "tokens": { "color/primary": { "flutter": "AppColors.primary", "web": "var(--color-primary)" } }
// }
// An empty string ("") means "not mapped yet".
import fs from 'node:fs';
import path from 'node:path';

export const MAP_FILE = 'figma-lens.map.json';

export function findMap(dirs) {
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, MAP_FILE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadMap(file) {
  if (!file || !fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { file, components: obj(raw.components), tokens: obj(raw.tokens) };
}

function isSet(entry) {
  if (typeof entry === 'string') return entry.trim() !== '';
  if (entry && typeof entry === 'object') return Object.entries(entry).some(([k, v]) => k !== 'props' && k !== 'note' && typeof v === 'string' && v.trim());
  return false;
}

// Exact key first, then the longest matching "Prefix*" wildcard. An exact key that is still
// an empty placeholder ("" from `figma-lens map`) means "no answer here", so fall through.
function lookup(table, name) {
  if (!table || !name) return null;
  if (Object.prototype.hasOwnProperty.call(table, name) && isSet(table[name])) return table[name];
  let best = null;
  for (const key of Object.keys(table)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (name.startsWith(prefix) && (!best || prefix.length > best.length - 1) && isSet(table[key])) best = key;
  }
  return best ? table[best] : null;
}

export const componentTarget = (map, name) => (map ? lookup(map.components, name) : null);
export const tokenTarget = (map, name) => (map ? lookup(map.tokens, name) : null);

export function targetStr(entry) {
  if (typeof entry === 'string') return entry;
  const parts = Object.entries(entry)
    .filter(([k, v]) => k !== 'props' && k !== 'note' && typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}: ${v}`);
  if (entry.props && Object.keys(entry.props).length) {
    parts.push('props ' + Object.entries(entry.props).map(([f, c]) => `${f}→${c}`).join(', '));
  }
  if (entry.note) parts.push(`note: ${entry.note}`);
  return parts.join(' · ');
}

function collect(designRoot) {
  const components = new Map();
  const tokens = new Set();
  if (!fs.existsSync(designRoot)) throw new Error(`${designRoot} does not exist`);
  for (const entry of fs.readdirSync(designRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(designRoot, entry.name);
    try {
      const { spec } = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
      (function walk(n) {
        if (n.component && !n.component.definition) components.set(n.component.name, (components.get(n.component.name) || 0) + 1);
        for (const c of n.children || []) walk(c);
      })(spec);
    } catch {
      continue; // not an export folder
    }
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
      for (const col of Object.values(t.variables || {})) for (const name of Object.keys(col.vars || {})) tokens.add(name);
      for (const name of Object.keys(t.styles || {})) tokens.add(name);
    } catch {
      // no tokens
    }
  }
  return { components, tokens };
}

/** Create or extend the map with every component/token seen in the exports. Never overwrites existing values. */
export function initMap({ designRoot, mapFile }) {
  const { components, tokens } = collect(designRoot);
  const existing = loadMap(mapFile) || { components: {}, tokens: {} };
  const added = { components: [], tokens: [] };
  for (const name of components.keys()) {
    if (!(name in existing.components) && !componentTarget(existing, name)) {
      existing.components[name] = { flutter: '', web: '', props: {} };
      added.components.push(name);
    }
  }
  for (const name of tokens) {
    if (!(name in existing.tokens) && !tokenTarget(existing, name)) {
      existing.tokens[name] = { flutter: '', web: '' };
      added.tokens.push(name);
    }
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const out = {
    $comment: 'figma-lens component map. Fill each "" with your real widget/token (file#Class or expression). Wildcards: "Icon/*".',
    components: sortObj(existing.components),
    tokens: sortObj(existing.tokens),
  };
  fs.writeFileSync(mapFile, JSON.stringify(out, null, 2) + '\n');
  const unmapped = {
    components: [...components.keys()].filter((n) => !componentTarget(out, n)),
    tokens: [...tokens].filter((n) => !tokenTarget(out, n)),
  };
  return { mapFile, added, unmapped, usage: Object.fromEntries(components) };
}
