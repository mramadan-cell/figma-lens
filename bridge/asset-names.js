// Meaningful names for exported icons and images.
// The plugin names an icon after its layer; frames imported from HTML only have layers called
// "Container", "SVG", "Vector"…, so icons arrive as container-12.svg, and bitmaps are named by hash.
// Here, in one pass over the spec tree (no AI, no extra I/O), each asset with a meaningless name
// gets the best name its context offers:
//   1. the component name        Icon/Arrow Right            → arrow-right.svg
//   2. the layer's own name       "Search"                    → search.svg
//   3. the nearest text label     icon next to "Book a call"  → book-a-call-icon.svg
//   4. a meaningful parent name   "Case Card" › Image         → case-card-image.jpg
// Names that already mean something are kept. Files and every reference in the spec are updated.

const GENERIC = new Set([
  'container', 'frame', 'group', 'svg', 'vector', 'layer', 'rectangle', 'rect', 'ellipse', 'line', 'polygon',
  'star', 'shape', 'union', 'subtract', 'intersect', 'exclude', 'path', 'background', 'bg', 'shadow', 'overlay',
  'margin', 'padding', 'wrapper', 'wrap', 'div', 'span', 'item', 'element', 'box', 'block', 'content', 'inner',
  'outer', 'html', 'body', 'main', 'link', 'image', 'img', 'icon', 'icons', 'ic', 'asset', 'mask', 'clip',
  'auto', 'layout', 'instance', 'component', 'copy', 'node', 'and', 'of', 'the', 'a', 'graphic', 'figure',
  'picture', 'photo', 'ui', 'el', 'symbol', 'boolean', 'flatten', 'combined', 'artboard',
]);
const MAX_WORDS = 5;
const MAX_LEN = 48;
const LABEL_MAX_WORDS = 6; // longer texts are content (a quote, a paragraph), never an icon's label

/** kebab-case ASCII words of a string (non-Latin letters drop out). */
function words(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Machine-made tokens are not words: ids/hashes like "ab6axuc", "6366hfllxb7slv", "f834a6f8".
// Real design words are short and don't mix letters with digits (except a few like 2fa, h1, 3d, 4k).
function junk(w) {
  if (/^\d+$/.test(w)) return true;
  if (w.length > 14) return true;
  if (/\d/.test(w) && /[a-z]/.test(w) && !/^(\d[a-z]{1,2}|[a-z]{1,2}\d)$/.test(w)) return true;
  if (w.length >= 5 && !/[aeiou]/.test(w)) return true; // no vowels ("xstjy", "kwfgh"): not a word
  return false;
}

/** The meaningful words of a name: generic layer words, numbers and machine ids removed. */
function meaningful(s) {
  return words(s).filter((w) => !GENERIC.has(w) && !junk(w));
}

function join(ws) {
  let out = ws.slice(0, MAX_WORDS).join('-');
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN).replace(/-[^-]*$/, '');
  return out;
}

/** True when a file stem carries no meaning: container-12, svg-3, a content hash… */
export function isMeaninglessStem(stem) {
  const base = String(stem).replace(/-\d+$/, '');
  if (/^[0-9a-f]{10,}$/i.test(base)) return true;
  return meaningful(base).length === 0;
}

const isRaster = (p) => /\.(png|jpe?g|webp|gif|avif)$/i.test(p);

// Text of a subtree, nearest first, with a cap so a whole section is never used as a "label".
function texts(node, out = [], depth = 0) {
  if (!node || depth > 3 || out.length > 3) return out;
  if (node.type === 'TEXT' && node.text && node.text.characters) out.push(node.text.characters);
  for (const c of node.children || []) texts(c, out, depth + 1);
  return out;
}

// How many asset-bearing layers (icons, image fills) a subtree holds, stopping at 2.
function assetCount(node, n = 0) {
  if (!node || n > 1) return n;
  if (node.asset || (node.fills || []).some((p) => p.asset)) n++;
  for (const c of node.children || []) n = assetCount(c, n);
  return n;
}

/** Best name for one usage of an asset. Returns { name, score } or null. */
function candidate(node, ancestors, raster) {
  const suffix = raster ? 'image' : 'icon';
  // 1. component name (last path segment): Icon/Arrow Right → arrow-right
  if (node.component && !node.component.definition) {
    const last = String(node.component.name).split('/').pop();
    const ws = meaningful(last);
    if (ws.length) return { name: join(ws), score: 4 };
  }
  // 2. the layer's own name
  const own = meaningful(node.name);
  if (own.length) return { name: join(own), score: 3 };
  // 3. nearest text label, but only inside the asset's own control: a parent (never the frame itself)
  //    that holds no other icon/image and only a few texts. Otherwise the text belongs to something else.
  for (let i = ancestors.length - 1, up = 0; i >= 1 && up < 3; i--, up++) {
    if (assetCount(ancestors[i]) > 1) break; // shared with another icon/image: not this one's label
    const found = texts(ancestors[i]);
    if (found.length > 3) break; // too many texts: we're at section level, not a label any more
    // A label is short (a button, link or list text). A paragraph next to an icon is content, not its name.
    // Initials ("ER", "DV" on an avatar) aren't labels either: at least one real word of 3+ letters.
    const label = found.filter((t) => words(t).length <= LABEL_MAX_WORDS).map(meaningful).find((ws) => ws.some((w) => w.length >= 3));
    if (label) return { name: join([...label.slice(0, MAX_WORDS - 1), suffix]), score: 2 };
  }
  // 4. nearest meaningful parent name
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ws = meaningful(ancestors[i].name);
    if (ws.length) return { name: join([...ws.slice(0, MAX_WORDS - 1), suffix]), score: 1 };
  }
  return null;
}

/**
 * Rename meaningless asset files of an export. Mutates spec (node.asset, fills[].asset) and
 * files[].path. Returns { renames: {old: new} }. Fast: one walk of the tree.
 */
export function nameAssets(spec, files) {
  // Best candidate per asset path, over every node that uses it (icons are deduplicated by content).
  const best = new Map();
  const consider = (assetPath, node, ancestors) => {
    if (!assetPath || !/^(assets|images)\//.test(assetPath)) return;
    const c = candidate(node, ancestors, isRaster(assetPath));
    if (!c) return;
    const prev = best.get(assetPath);
    if (!prev || c.score > prev.score) best.set(assetPath, c);
  };
  (function walk(node, ancestors) {
    if (!node) return;
    consider(node.asset, node, ancestors);
    for (const p of node.fills || []) consider(p.asset, node, ancestors);
    const next = [...ancestors, node];
    for (const c of node.children || []) walk(c, next);
  })(spec, []);

  const present = new Set(files.map((f) => f.path));
  const taken = new Set(present);
  const renames = {};
  for (const [oldPath, c] of best) {
    if (!present.has(oldPath)) continue; // referenced but not there (export failed, file deleted): leave it alone
    const dir = oldPath.slice(0, oldPath.lastIndexOf('/'));
    const file = oldPath.slice(oldPath.lastIndexOf('/') + 1);
    const dot = file.lastIndexOf('.');
    const stem = file.slice(0, dot);
    const ext = file.slice(dot);
    if (!isMeaninglessStem(stem) || !c.name) continue;
    let target = `${dir}/${c.name}${ext}`;
    for (let i = 2; taken.has(target) && target !== oldPath; i++) target = `${dir}/${c.name}-${i}${ext}`;
    if (target === oldPath) continue;
    taken.delete(oldPath);
    taken.add(target);
    renames[oldPath] = target;
  }
  if (!Object.keys(renames).length) return { renames };

  for (const f of files) if (renames[f.path]) f.path = renames[f.path];
  (function rewrite(node) {
    if (!node) return;
    if (node.asset && renames[node.asset]) node.asset = renames[node.asset];
    for (const p of node.fills || []) if (p.asset && renames[p.asset]) p.asset = renames[p.asset];
    for (const c of node.children || []) rewrite(c);
  })(spec);
  return { renames };
}
