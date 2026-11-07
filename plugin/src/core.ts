/// <reference types="@figma/plugin-typings" />
// Figma Lens core: reads one frame through the Figma Plugin API and produces a framework-neutral
// spec + frame preview + icons + images. Shared by two entries that only differ in where files go:
//   code.ts  the Figma plugin (desktop app): files go to the plugin UI, which uploads them to the bridge
//   page.ts  figma-lens browser (figma.com in Chrome/Edge): files go straight to the figma-lens CLI
// So this file must not touch figma.ui, figma.showUI or __html__.

export const VERSION = '0.2.0';
// Both limits are set in the plugin UI; 0 means no limit. The layer limit is off by default: the walk
// yields to Figma regularly, so big frames take longer but never freeze it or come back incomplete.
const DEFAULT_MAX_LAYERS = 0;
const DEFAULT_CSS_LIMIT = 3000; // getCSSAsync is the slow part; CSS mostly repeats the spec
const CSS_CONCURRENCY = 8;

/** Options from the plugin UI or the CLI, with defaults and bad values replaced. */
export function normalizeOptions(raw: Json): Options {
  const r = raw || {};
  const scale = [1, 2, 3, 4].indexOf(Number(r.scale)) >= 0 ? Number(r.scale) : 2;
  const limit = (v: unknown, d: number): number => {
    const n = v === undefined || v === null || v === '' ? d : Math.floor(Number(v));
    return isFinite(n) && n >= 0 ? n : d;
  };
  return {
    scale,
    css: r.css !== false,
    sections: r.sections !== false,
    maxLayers: limit(r.maxLayers, DEFAULT_MAX_LAYERS),
    cssLimit: limit(r.cssLimit, DEFAULT_CSS_LIMIT),
  };
}
const YIELD_EVERY = 200; // layers between pauses that let Figma repaint and handle input
const MAX_SKIPPED_LISTED = 200;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Options {
  scale: number;
  css: boolean;
  sections: boolean;
  maxLayers: number; // 0 = no limit
  cssLimit: number; // 0 = no limit
}

/** Where an export sends its output. file() is called once per file, as soon as it exists. */
export interface Sink {
  file(path: string, bytes: Uint8Array): void;
  progress(text: string): void;
}

interface OutFile {
  path: string;
  size: number;
}

const SHAPE_TYPES: string[] = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE', 'RECTANGLE'];
const DRAWN_TYPES: string[] = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON'];
const CONTAINER_TYPES: string[] = ['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT'];

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function hex(c: RGB | RGBA, extraAlpha = 1): string {
  const to = (v: number): string => {
    const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).toUpperCase();
    return s.length === 1 ? '0' + s : s;
  };
  const a = ('a' in c ? c.a : 1) * extraAlpha;
  return '#' + to(c.r) + to(c.g) + to(c.b) + (a < 0.995 ? to(a) : '');
}

function hashBytes(bytes: Uint8Array): string {
  // FNV-1a, enough to dedupe identical SVG exports
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function sniffExt(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  return 'bin';
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(n: SceneNode): Box {
  const b = 'absoluteBoundingBox' in n ? n.absoluteBoundingBox : null;
  if (b) return b;
  const t = n.absoluteTransform;
  return { x: t[0][2], y: t[1][2], width: n.width, height: n.height };
}

class Ctx {
  files: OutFile[] = []; // paths only: the bytes go to the UI as soon as they exist (see emit)
  count = 0;
  cssCount = 0;
  cssQueue: { n: SceneNode; s: Json }[] = [];
  truncated = false;
  skipped: Json[] = []; // roots of subtrees left out by the layer limit
  skippedCount = 0;
  warnings: string[] = [];
  imageByHash = new Map<string, string>();
  assetByContent = new Map<string, string>();
  usedPaths = new Set<string>();
  variables: Record<string, Json> = {};
  seenVars = new Set<string>();
  styles: Record<string, Json> = {};
  styleNames = new Map<string, string | null>();
  destinations = new Set<string>(); // prototype link targets, resolved after the walk
  navActions: Json[] = []; // exported actions that point at a node; they get its name after the walk
  links: Json[] = []; // every prototype action with the layer that triggers it (meta.prototype.links)
  ox: number;
  oy: number;

  constructor(public root: SceneNode, public opts: Options, public sink: Sink) {
    const b = boxOf(root);
    this.ox = b.x;
    this.oy = b.y;
  }

  // Hand one file to the sink right away. It is sent on while the walk continues, so no single
  // message or request has to carry the whole export.
  emit(path: string, bytes: Uint8Array): void {
    this.sink.file(path, bytes);
    this.files.push({ path, size: bytes.length });
  }

  progress(text: string): void {
    this.sink.progress(text);
  }

  uniquePath(dir: string, base: string, ext: string): string {
    let p = dir + '/' + base + '.' + ext;
    let i = 2;
    while (this.usedPaths.has(p)) p = dir + '/' + base + '-' + i++ + '.' + ext;
    this.usedPaths.add(p);
    return p;
  }
}

// ---------- variables & styles ----------

async function varValue(ctx: Ctx, val: VariableValue, type: VariableResolvedDataType, depth: number): Promise<Json> {
  if (val && typeof val === 'object' && 'type' in val && val.type === 'VARIABLE_ALIAS') {
    const target = await figma.variables.getVariableByIdAsync(val.id);
    if (!target) return null;
    await recordVariable(ctx, target, depth + 1);
    return { alias: target.name };
  }
  if (type === 'COLOR' && val && typeof val === 'object' && 'r' in val) return hex(val as RGBA);
  return val;
}

async function recordVariable(ctx: Ctx, v: Variable, depth: number): Promise<void> {
  if (ctx.seenVars.has(v.id) || depth > 6) return;
  ctx.seenVars.add(v.id);
  const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  const colName = col ? col.name : 'unknown';
  let bucket = ctx.variables[colName];
  if (!bucket) bucket = ctx.variables[colName] = { modes: col ? col.modes.map((m) => m.name) : [], vars: {} };
  const values: Record<string, Json> = {};
  for (const modeId of Object.keys(v.valuesByMode)) {
    const mode = col ? col.modes.find((m) => m.modeId === modeId) : undefined;
    values[mode ? mode.name : modeId] = await varValue(ctx, v.valuesByMode[modeId], v.resolvedType, depth);
  }
  const entry: Json = { type: v.resolvedType, values };
  if (v.codeSyntax && Object.keys(v.codeSyntax).length) entry.code = v.codeSyntax;
  if (v.description) entry.description = v.description;
  bucket.vars[v.name] = entry;
}

async function varName(ctx: Ctx, alias: VariableAlias | undefined | null): Promise<string | undefined> {
  if (!alias || !alias.id) return undefined;
  try {
    const v = await figma.variables.getVariableByIdAsync(alias.id);
    if (!v) return undefined;
    await recordVariable(ctx, v, 0);
    return v.name;
  } catch (e) {
    return undefined;
  }
}

function lineHeight(v: LineHeight | PluginAPI['mixed']): Json {
  if (typeof v === 'symbol') return 'mixed';
  if (v.unit === 'AUTO') return 'auto';
  if (v.unit === 'PIXELS') return r2(v.value);
  return r2(v.value) + '%';
}

function letterSpacing(v: LetterSpacing | PluginAPI['mixed']): Json {
  if (typeof v === 'symbol') return 'mixed';
  if (v.unit === 'PIXELS') return r2(v.value);
  return r2(v.value) + '%';
}

async function styleValue(ctx: Ctx, st: BaseStyle): Promise<Json> {
  if (st.type === 'PAINT') return { type: 'paint', paints: await paints(ctx, (st as PaintStyle).paints) };
  if (st.type === 'TEXT') {
    const t = st as TextStyle;
    return {
      type: 'text',
      font: t.fontName.family,
      style: t.fontName.style,
      size: t.fontSize,
      lineHeight: lineHeight(t.lineHeight),
      letterSpacing: letterSpacing(t.letterSpacing),
      case: t.textCase,
      decoration: t.textDecoration,
    };
  }
  if (st.type === 'EFFECT') return { type: 'effect', effects: effects((st as EffectStyle).effects) };
  return { type: String(st.type).toLowerCase() };
}

async function styleName(ctx: Ctx, id: unknown): Promise<string | undefined> {
  if (!id || typeof id !== 'string') return undefined;
  if (ctx.styleNames.has(id)) return ctx.styleNames.get(id) || undefined;
  let name: string | null = null;
  try {
    const st = await figma.getStyleByIdAsync(id);
    if (st) {
      name = st.name;
      ctx.styles[st.name] = await styleValue(ctx, st);
    }
  } catch (e) {
    ctx.warnings.push('style ' + id + ': ' + errMsg(e));
  }
  ctx.styleNames.set(id, name);
  return name || undefined;
}

// ---------- paints & effects ----------

function gradientEnds(t: Transform): { from: number[]; to: number[] } | null {
  // gradientTransform maps layer space -> gradient space; invert it and map the
  // gradient axis (0,0.5)->(1,0.5) back into normalized layer coordinates (0..1).
  const [[a, b, c], [d, e, f]] = t;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-9) return null;
  const ia = e / det, ib = -b / det, ic = (b * f - e * c) / det;
  const id = -d / det, ie = a / det, iff = (d * c - a * f) / det;
  const map = (x: number, y: number): number[] => [
    Math.round((ia * x + ib * y + ic) * 1000) / 1000,
    Math.round((id * x + ie * y + iff) * 1000) / 1000,
  ];
  return { from: map(0, 0.5), to: map(1, 0.5) };
}

async function imageAsset(ctx: Ctx, hash: string): Promise<string | undefined> {
  const known = ctx.imageByHash.get(hash);
  if (known) return known;
  try {
    const img = figma.getImageByHash(hash);
    if (!img) return undefined;
    const bytes = await img.getBytesAsync();
    const path = ctx.uniquePath('images', hash.slice(0, 16), sniffExt(bytes));
    ctx.emit(path, bytes);
    ctx.imageByHash.set(hash, path);
    return path;
  } catch (e) {
    ctx.warnings.push('image ' + hash + ': ' + errMsg(e));
    return undefined;
  }
}

async function paint(ctx: Ctx, p: Paint, size?: { w: number; h: number }): Promise<Json | null> {
  if (p.visible === false) return null;
  const op = p.opacity === undefined ? 1 : p.opacity;
  let j: Json;
  if (p.type === 'SOLID') {
    j = { type: 'solid', color: hex(p.color, op) };
    const v = await varName(ctx, p.boundVariables && p.boundVariables.color);
    if (v) j.var = v;
  } else if (
    p.type === 'GRADIENT_LINEAR' ||
    p.type === 'GRADIENT_RADIAL' ||
    p.type === 'GRADIENT_ANGULAR' ||
    p.type === 'GRADIENT_DIAMOND'
  ) {
    j = {
      type: p.type.toLowerCase().replace('_', '-'),
      stops: p.gradientStops.map((s) => ({ color: hex(s.color), pos: r2(s.position) })),
    };
    if (op < 1) j.opacity = r2(op);
    const ends = gradientEnds(p.gradientTransform);
    if (ends) {
      j.from = ends.from;
      j.to = ends.to;
      if (p.type === 'GRADIENT_LINEAR' && size) {
        const dx = (ends.to[0] - ends.from[0]) * size.w;
        const dy = (ends.to[1] - ends.from[1]) * size.h;
        j.cssAngle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
      }
    }
  } else if (p.type === 'IMAGE') {
    j = { type: 'image', scaleMode: p.scaleMode };
    if (op < 1) j.opacity = r2(op);
    if (p.imageHash) {
      const a = await imageAsset(ctx, p.imageHash);
      if (a) j.asset = a;
    }
  } else {
    j = { type: String(p.type).toLowerCase() };
  }
  if (p.blendMode && p.blendMode !== 'NORMAL' && p.blendMode !== 'PASS_THROUGH') j.blend = p.blendMode;
  return j;
}

async function paints(
  ctx: Ctx,
  list: ReadonlyArray<Paint> | PluginAPI['mixed'],
  size?: { w: number; h: number },
): Promise<Json[]> {
  if (typeof list === 'symbol') return [];
  const out: Json[] = [];
  for (const p of list) {
    const j = await paint(ctx, p, size);
    if (j) out.push(j);
  }
  return out;
}

function effects(list: ReadonlyArray<Effect>): Json[] {
  const out: Json[] = [];
  for (const e of list) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push({
        type: e.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow',
        x: r2(e.offset.x),
        y: r2(e.offset.y),
        blur: r2(e.radius),
        spread: r2(e.spread || 0),
        color: hex(e.color),
      });
    } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      out.push({ type: e.type === 'LAYER_BLUR' ? 'layer-blur' : 'background-blur', radius: r2((e as Json).radius) });
    } else {
      out.push({ type: String((e as Json).type).toLowerCase() });
    }
  }
  return out;
}

// ---------- icons / vector assets ----------

// A paint/effect only "shows" if it is enabled AND not fully transparent.
function shows(p: Json): boolean {
  if (!p || p.visible === false) return false;
  if (typeof p.opacity === 'number' && p.opacity <= 0) return false;
  if (p.color && typeof p.color.a === 'number' && p.color.a <= 0) return false;
  if (Array.isArray(p.gradientStops) && p.gradientStops.every((s: Json) => s.color.a <= 0)) return false;
  return true;
}

function visiblePaints(arr: unknown): boolean {
  return Array.isArray(arr) && arr.some(shows);
}

function hasOwnPaint(n: SceneNode): boolean {
  return (
    ('fills' in n && visiblePaints(n.fills)) ||
    ('strokes' in n && visiblePaints(n.strokes)) ||
    ('effects' in n && visiblePaints(n.effects))
  );
}

function isVectorOnly(n: SceneNode): boolean {
  if (!n.visible) return true;
  if (SHAPE_TYPES.indexOf(n.type) >= 0) {
    if ('fills' in n && Array.isArray(n.fills) && n.fills.some((p: Paint) => p.type === 'IMAGE' && p.visible !== false)) {
      return false;
    }
    return true;
  }
  if (CONTAINER_TYPES.indexOf(n.type) >= 0 && 'children' in n) {
    const kids = n.children.filter((c) => c.visible);
    return kids.length > 0 && kids.every(isVectorOnly);
  }
  return false;
}

function hasDrawn(n: SceneNode): boolean {
  if (!n.visible) return false;
  if (DRAWN_TYPES.indexOf(n.type) >= 0) return true;
  return 'children' in n && n.children.some(hasDrawn);
}

function isAssetNode(n: SceneNode, root: SceneNode): boolean {
  if (n === root) return false;
  if (DRAWN_TYPES.indexOf(n.type) >= 0) return true;
  if (CONTAINER_TYPES.indexOf(n.type) >= 0) {
    // A container with its own background is UI (e.g. icon button) — descend instead.
    if (n.type !== 'GROUP' && hasOwnPaint(n)) return false;
    return isVectorOnly(n) && hasDrawn(n);
  }
  return false;
}

async function vectorAsset(ctx: Ctx, n: SceneNode, baseName: string): Promise<string | undefined> {
  try {
    const bytes = await n.exportAsync({ format: 'SVG', svgOutlineText: true, svgIdAttribute: false });
    const key = hashBytes(bytes);
    const known = ctx.assetByContent.get(key);
    if (known) return known;
    const path = ctx.uniquePath('assets', slugify(baseName) || 'icon', 'svg');
    ctx.emit(path, bytes);
    ctx.assetByContent.set(key, path);
    return path;
  } catch (e) {
    ctx.warnings.push('svg export failed for ' + n.name + ' (' + n.id + '): ' + errMsg(e));
    return undefined;
  }
}

// ---------- components ----------

function variantLabel(variantName: string): string {
  return variantName
    .split(',')
    .map((part) => {
      const kv = part.split('=');
      return (kv.length > 1 ? kv[1] : kv[0]).trim();
    })
    .join(' ');
}

async function instanceInfo(n: InstanceNode): Promise<{ info: Json; assetName: string }> {
  const info: Json = {};
  let assetName = n.name;
  let main: ComponentNode | null = null;
  try {
    main = await n.getMainComponentAsync();
  } catch (e) {
    main = null;
  }
  if (main) {
    const set = main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;
    info.name = set ? set.name : main.name;
    if (set) info.variant = main.name;
    if (main.remote) info.remote = true;
    assetName = set ? set.name + ' ' + variantLabel(main.name) : main.name;
  } else {
    info.name = n.name;
  }
  try {
    const props = n.componentProperties;
    const out: Json = {};
    for (const key of Object.keys(props)) {
      const p = props[key];
      if (p.type === 'VARIANT') continue; // already in info.variant
      let v: Json = p.value;
      if (p.type === 'INSTANCE_SWAP' && typeof v === 'string') {
        const swapped = await figma.getNodeByIdAsync(v);
        v = swapped ? swapped.name : v;
      }
      out[key.split('#')[0]] = v;
    }
    if (Object.keys(out).length) info.props = out;
  } catch (e) {
    // componentProperties throws on some broken instances; the name is still useful
  }
  return { info, assetName };
}

// ---------- text ----------

async function textInfo(ctx: Ctx, n: TextNode): Promise<Json> {
  const t: Json = {
    characters: n.characters,
    align: n.textAlignHorizontal,
    valign: n.textAlignVertical,
    autoResize: n.textAutoResize,
  };
  const anyN = n as Json;
  if (anyN.textTruncation === 'ENDING') {
    t.truncate = true;
    if (anyN.maxLines) t.maxLines = anyN.maxLines;
  }
  if (n.paragraphSpacing) t.paragraphSpacing = n.paragraphSpacing;

  const segs: Json[] = [];
  try {
    const raw = n.getStyledTextSegments([
      'fontName',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'fills',
      'textDecoration',
      'textCase',
      'textStyleId',
    ]);
    for (const g of raw) {
      const s: Json = {
        text: g.characters,
        font: g.fontName.family,
        style: g.fontName.style,
        weight: g.fontWeight,
        size: g.fontSize,
        lineHeight: lineHeight(g.lineHeight),
        letterSpacing: letterSpacing(g.letterSpacing),
        fills: await paints(ctx, g.fills),
      };
      if (g.textDecoration && g.textDecoration !== 'NONE') s.decoration = g.textDecoration;
      if (g.textCase && g.textCase !== 'ORIGINAL') s.case = g.textCase;
      const ts = await styleName(ctx, g.textStyleId);
      if (ts) s.textStyle = ts;
      segs.push(s);
    }
  } catch (e) {
    ctx.warnings.push('text styles for ' + n.name + ': ' + errMsg(e));
  }

  if (segs.length) {
    // Dominant (longest) run goes on the node; all runs kept when they differ.
    let dom = segs[0];
    for (const s of segs) if (s.text.length > dom.text.length) dom = s;
    for (const k of Object.keys(dom)) if (k !== 'text') t[k] = dom[k];
    if (segs.length > 1) t.segments = segs;
  }
  return t;
}

// ---------- prototype (relations between screens) ----------

function triggerOf(t: Json): Json {
  const j: Json = { type: t.type };
  if (typeof t.timeout === 'number') j.timeout = t.timeout;
  if (typeof t.delay === 'number' && t.delay > 0) j.delay = t.delay;
  if (Array.isArray(t.keyCodes)) j.keyCodes = t.keyCodes;
  return j;
}

function transitionOf(t: Json): Json {
  const j: Json = { type: t.type, duration: t.duration };
  if (t.direction) j.direction = t.direction;
  if (t.easing && t.easing.type) j.easing = t.easing.type;
  if (t.matchLayers) j.matchLayers = true;
  return j;
}

async function actionOf(ctx: Ctx, a: Json, depth: number): Promise<Json | null> {
  if (!a || !a.type) return null;
  const j: Json = { type: a.type };
  if (a.type === 'NODE') {
    j.navigation = a.navigation;
    if (a.destinationId) {
      j.to = a.destinationId;
      ctx.destinations.add(a.destinationId);
      ctx.navActions.push(j);
    }
    if (a.transition) j.transition = transitionOf(a.transition);
    if (a.preserveScrollPosition) j.preserveScroll = true;
    if (a.resetScrollPosition) j.resetScroll = true;
    if (a.overlayRelativePosition) j.overlayOffset = { x: r2(a.overlayRelativePosition.x), y: r2(a.overlayRelativePosition.y) };
  } else if (a.type === 'URL') {
    j.url = a.url;
    if (a.openInNewTab) j.newTab = true;
  } else if (a.type === 'SET_VARIABLE') {
    j.variable = (await varName(ctx, { type: 'VARIABLE_ALIAS', id: a.variableId } as VariableAlias)) || a.variableId;
    if (a.variableValue && a.variableValue.value !== undefined) {
      const v = a.variableValue.value;
      j.value = v && typeof v === 'object' && 'r' in v ? hex(v as RGBA) : v;
    }
  } else if (a.type === 'SET_VARIABLE_MODE') {
    j.collection = a.variableCollectionId;
    j.mode = a.variableModeId;
  } else if (a.type === 'CONDITIONAL' && depth < 4) {
    j.blocks = [];
    for (const b of a.conditionalBlocks || []) {
      const acts: Json[] = [];
      for (const x of b.actions || []) {
        const k = await actionOf(ctx, x, depth + 1);
        if (k) acts.push(k);
      }
      j.blocks.push({ when: b.condition ? 'condition' : 'else', actions: acts });
    }
  }
  return j;
}

async function reactionsOf(ctx: Ctx, n: SceneNode): Promise<Json[] | undefined> {
  let list: Json;
  try {
    list = (n as Json).reactions;
  } catch (e) {
    return undefined; // some node types throw instead of returning []
  }
  if (!Array.isArray(list) || !list.length) return undefined;
  const out: Json[] = [];
  for (const r of list) {
    const raw = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
    const actions: Json[] = [];
    for (const a of raw) {
      const j = await actionOf(ctx, a, 0);
      if (j) actions.push(j);
    }
    if (!actions.length) continue;
    const trigger = r.trigger ? triggerOf(r.trigger) : null;
    out.push({ trigger, actions });
    // Flat list for the screen map (FLOWS.md): one entry per action, conditional branches included.
    const collect = (j: Json, conditional: boolean): void => {
      if (j.type === 'CONDITIONAL') {
        for (const b of j.blocks || []) for (const x of b.actions) collect(x, true);
        return;
      }
      ctx.links.push({ layer: n.id, layerName: n.name, trigger: trigger ? trigger.type : null, conditional, action: j });
    };
    for (const j of actions) collect(j, false);
  }
  return out.length ? out : undefined;
}

function pageOf(n: BaseNode | null): PageNode | null {
  let p: BaseNode | null = n;
  while (p && p.type !== 'PAGE') p = p.parent;
  return p as PageNode | null;
}

function pageNameOf(n: BaseNode | null): string | undefined {
  const p = pageOf(n);
  return p ? p.name : undefined;
}

function isInside(n: BaseNode, root: BaseNode): boolean {
  for (let p: BaseNode | null = n; p; p = p.parent) if (p === root) return true;
  return false;
}

// Every frame has overlay settings (CENTER by default), so they are only recorded for a frame that a
// link opens as an overlay; otherwise every screen would look like a modal.
function screenInfo(n: Json, asOverlay: boolean): Json {
  const j: Json = {};
  if (n.overflowDirection && n.overflowDirection !== 'NONE') j.scrolls = n.overflowDirection;
  if (typeof n.numberOfFixedChildren === 'number' && n.numberOfFixedChildren > 0) j.fixedChildren = n.numberOfFixedChildren;
  if (asOverlay && n.overlayPositionType) {
    j.overlay = { position: n.overlayPositionType };
    const bg = n.overlayBackground;
    if (bg && bg.type === 'SOLID_COLOR' && bg.color) j.overlay.background = hex(bg.color);
    if (n.overlayBackgroundInteraction) j.overlay.closeOnOutsideClick = n.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE';
  }
  return j;
}

/** Flows, this screen's scroll/overlay settings, and the names of every node a link points at. */
async function prototypeOf(ctx: Ctx, node: SceneNode): Promise<Json | undefined> {
  const p: Json = {};
  try {
    // The frame's own page: a frame exported by link can be on another page than the current one.
    const page = pageOf(node);
    const flows = (page ? page.flowStartingPoints : figma.currentPage.flowStartingPoints) || [];
    if (flows.length) p.flows = flows.map((f) => ({ name: f.name, start: f.nodeId }));
  } catch (e) {
    // flows are optional
  }
  const screen = screenInfo(node, false);
  if (Object.keys(screen).length) p.screen = screen;
  const overlays = new Set(ctx.navActions.filter((a) => a.navigation === 'OVERLAY' || a.navigation === 'SWAP').map((a) => a.to));
  if (ctx.destinations.size) {
    const names = new Map<string, string>();
    p.destinations = [];
    for (const id of ctx.destinations) {
      try {
        const d = await figma.getNodeByIdAsync(id);
        if (!d) {
          p.destinations.push({ id, missing: true });
          continue;
        }
        names.set(id, d.name);
        const e: Json = { id, name: d.name, type: d.type, page: pageNameOf(d) };
        if (isInside(d, node)) e.inside = true; // e.g. scroll-to inside this screen
        else Object.assign(e, screenInfo(d, overlays.has(id)));
        p.destinations.push(e);
      } catch (e) {
        ctx.warnings.push('prototype link target ' + id + ': ' + errMsg(e));
        p.destinations.push({ id, missing: true });
      }
    }
    for (const a of ctx.navActions) if (names.has(a.to)) a.toName = names.get(a.to);
  }
  if (ctx.links.length) {
    p.links = ctx.links.map((l) => {
      const e: Json = { layer: l.layer, layerName: l.layerName, trigger: l.trigger };
      if (l.conditional) e.conditional = true;
      return Object.assign(e, l.action);
    });
    const targets: string[] = [];
    for (const l of p.links) {
      const label = l.toName ? '"' + l.toName + '"' : l.type === 'URL' ? l.url : l.type.toLowerCase();
      if (targets.indexOf(label) < 0) targets.push(label);
    }
    ctx.progress('Prototype: ' + p.links.length + ' link(s) → ' + targets.slice(0, 8).join(', ') + (targets.length > 8 ? ', …' : ''));
  }
  return Object.keys(p).length ? p : undefined;
}

// ---------- tree walk ----------

function strokeWeight(n: SceneNode): Json {
  const anyN = n as Json;
  if (typeof anyN.strokeWeight === 'symbol' && 'strokeTopWeight' in anyN) {
    return [anyN.strokeTopWeight, anyN.strokeRightWeight, anyN.strokeBottomWeight, anyN.strokeLeftWeight];
  }
  return anyN.strokeWeight;
}

async function boundVars(ctx: Ctx, n: SceneNode): Promise<Json | undefined> {
  const bv = (n as Json).boundVariables;
  if (!bv) return undefined;
  const out: Json = {};
  for (const key of Object.keys(bv)) {
    if (key === 'fills' || key === 'strokes' || key === 'effects' || key === 'componentProperties') continue;
    const val = bv[key];
    if (Array.isArray(val)) {
      const names: string[] = [];
      for (const a of val) {
        const nm = await varName(ctx, a);
        if (nm && names.indexOf(nm) < 0) names.push(nm);
      }
      if (names.length) out[key] = names.join(' | ');
    } else {
      const nm = await varName(ctx, val);
      if (nm) out[key] = nm;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function walk(ctx: Ctx, n: SceneNode, parent: SceneNode | null): Promise<Json | null> {
  if (!n.visible) return null;
  if (ctx.opts.maxLayers > 0 && ctx.count >= ctx.opts.maxLayers) {
    // Say exactly what is missing, so it can be exported on its own instead of silently dropped.
    ctx.truncated = true;
    ctx.skippedCount++;
    if (ctx.skipped.length < MAX_SKIPPED_LISTED) {
      const b = boxOf(n);
      ctx.skipped.push({ id: n.id, name: n.name, type: n.type, box: { x: r2(b.x - ctx.ox), y: r2(b.y - ctx.oy), w: r2(n.width), h: r2(n.height) } });
    }
    return null;
  }
  ctx.count++;
  if (ctx.count % YIELD_EVERY === 0) {
    ctx.progress('Read ' + ctx.count + ' layers…');
    await pause();
  }

  const anyN = n as Json;
  const b = boxOf(n);
  const s: Json = {
    id: n.id,
    name: n.name,
    type: n.type,
    box: { x: r2(b.x - ctx.ox), y: r2(b.y - ctx.oy), w: r2(n.width), h: r2(n.height) },
  };
  if (parent) {
    const pb = boxOf(parent);
    s.rel = { x: r2(b.x - pb.x), y: r2(b.y - pb.y) };
  }
  if ('rotation' in n && Math.abs(n.rotation) > 0.01) s.rotation = r2(n.rotation);
  if ('opacity' in n && n.opacity < 1) s.opacity = r2(n.opacity);
  if ('blendMode' in n && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL') s.blend = n.blendMode;
  if ('isMask' in n && n.isMask) s.mask = true;

  // Auto layout on this node
  if ('layoutMode' in n && (n.layoutMode as string) !== 'NONE') {
    const mode = n.layoutMode as string;
    const L: Json = {
      mode: mode === 'HORIZONTAL' ? 'row' : mode === 'VERTICAL' ? 'column' : mode.toLowerCase(),
      gap: r2(n.itemSpacing),
      padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(r2),
      main: n.primaryAxisAlignItems,
      cross: n.counterAxisAlignItems,
    };
    if (n.layoutWrap === 'WRAP') {
      L.wrap = true;
      if (n.counterAxisSpacing != null) L.rowGap = r2(n.counterAxisSpacing);
      L.wrapAlign = n.counterAxisAlignContent;
    }
    if (mode === 'GRID') {
      L.grid = {
        rows: anyN.gridRowCount,
        cols: anyN.gridColumnCount,
        rowGap: anyN.gridRowGap,
        colGap: anyN.gridColumnGap,
      };
    }
    if (n.strokesIncludedInLayout) L.strokesInLayout = true;
    s.layout = L;
  }

  // How this node sits inside its parent
  const parentAuto = !!parent && 'layoutMode' in parent && (parent.layoutMode as string) !== 'NONE';
  if ('layoutSizingHorizontal' in n && (parentAuto || s.layout || n.type === 'TEXT')) {
    try {
      s.sizing = { h: n.layoutSizingHorizontal, v: n.layoutSizingVertical };
    } catch (e) {
      // not applicable for this node
    }
  }
  if (parentAuto) {
    if ('layoutPositioning' in n && n.layoutPositioning === 'ABSOLUTE') s.absolute = true;
    if ('layoutGrow' in n && n.layoutGrow) s.grow = n.layoutGrow;
  }
  for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
    if (k in n && anyN[k] != null) s[k] = r2(anyN[k]);
  }
  if ((!parentAuto || s.absolute) && parent && 'constraints' in n) {
    s.constraints = { h: n.constraints.horizontal, v: n.constraints.vertical };
  }
  if ('clipsContent' in n && n.clipsContent) s.clips = true;

  // Visual style
  const size = { w: n.width, h: n.height };
  if ('fills' in n) {
    const f = await paints(ctx, n.fills, size);
    if (f.length) s.fills = f;
    const fs = await styleName(ctx, anyN.fillStyleId);
    if (fs) s.fillStyle = fs;
  }
  if ('strokes' in n && n.strokes.length) {
    const sp = await paints(ctx, n.strokes, size);
    if (sp.length) {
      s.stroke = { paints: sp, weight: strokeWeight(n), align: anyN.strokeAlign };
      if (Array.isArray(anyN.dashPattern) && anyN.dashPattern.length) s.stroke.dash = anyN.dashPattern;
      const ss = await styleName(ctx, anyN.strokeStyleId);
      if (ss) s.strokeStyle = ss;
    }
  }
  if ('cornerRadius' in n) {
    if (typeof n.cornerRadius === 'symbol' && 'topLeftRadius' in n) {
      s.radius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(r2);
    } else if (typeof n.cornerRadius === 'number' && n.cornerRadius > 0) {
      s.radius = r2(n.cornerRadius);
    }
    if ('cornerSmoothing' in n && n.cornerSmoothing > 0) s.smoothing = r2(n.cornerSmoothing);
  }
  if ('effects' in n && n.effects.length) {
    const e = effects(n.effects);
    if (e.length) s.effects = e;
    const es = await styleName(ctx, anyN.effectStyleId);
    if (es) s.effectStyle = es;
  }
  const vars = await boundVars(ctx, n);
  if (vars) s.vars = vars;

  // Components
  let assetName = n.name;
  if (n.type === 'INSTANCE') {
    const r = await instanceInfo(n);
    s.component = r.info;
    assetName = r.assetName;
  } else if (n.type === 'COMPONENT') {
    const set = n.parent && n.parent.type === 'COMPONENT_SET' ? n.parent : null;
    s.component = { definition: true, name: set ? set.name : n.name };
    if (set) s.component.variant = n.name;
  }

  // Prototype links (before the icon early-return: a tappable icon is often exported as one SVG).
  const reactions = await reactionsOf(ctx, n);
  if (reactions) s.reactions = reactions;

  // Icons / vector art: export as one SVG and stop descending.
  if (isAssetNode(n, ctx.root)) {
    const a = await vectorAsset(ctx, n, assetName);
    if (a) {
      s.asset = a;
      return s;
    }
  }

  if (n.type === 'TEXT') s.text = await textInfo(ctx, n);

  // CSS is fetched after the walk, only for layers where it adds something (own look, layout or text).
  if (ctx.opts.css && (s.fills || s.stroke || s.effects || s.radius || s.layout || s.text || s.opacity || s.rotation || s.blend)) {
    ctx.cssQueue.push({ n, s });
  }

  if ('children' in n) {
    const kids: Json[] = [];
    for (const c of n.children) {
      const k = await walk(ctx, c, n);
      if (k) kids.push(k);
    }
    if (kids.length) s.children = kids;
  }
  return s;
}

// Top-level blocks of the screen; the bridge crops them out of the full screenshot
// so Claude can look at each part at full resolution (big images get downscaled).
function pickSections(ctx: Ctx, root: SceneNode): Json[] {
  if (!('children' in root)) return [];
  let list: ReadonlyArray<SceneNode> = root.children.filter((c) => c.visible);
  if (list.length === 1) {
    const only = list[0];
    if ('children' in only && only.children.length > 1) list = only.children.filter((c) => c.visible);
  }
  const picked = list.filter((c) => c.width >= 24 && c.height >= 24).slice(0, 30);
  if (picked.length < 2) return [];
  return picked.map((c) => {
    const b = boxOf(c);
    return { id: c.id, name: c.name, box: { x: r2(b.x - ctx.ox), y: r2(b.y - ctx.oy), w: r2(b.width), h: r2(b.height) } };
  });
}

// getCSSAsync for the queued layers, a few at a time, up to the CSS limit (0 = all).
async function addCss(ctx: Ctx): Promise<void> {
  const limit = ctx.opts.cssLimit > 0 ? ctx.opts.cssLimit : ctx.cssQueue.length;
  const todo = ctx.cssQueue.slice(0, limit);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const job = todo[next++];
      try {
        job.s.css = await job.n.getCSSAsync();
        ctx.cssCount++;
      } catch (e) {
        // CSS is optional enrichment only
      }
      if (ctx.cssCount % YIELD_EVERY === 0) {
        ctx.progress('CSS for ' + ctx.cssCount + ' / ' + todo.length + ' layers…');
        await pause();
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CSS_CONCURRENCY, todo.length); i++) workers.push(worker());
  await Promise.all(workers);
}

// figma.fileKey exists only for some plugin kinds and on figma.com; it is optional.
function fileKeyOf(): string | undefined {
  try {
    const k = (figma as Json).fileKey;
    return typeof k === 'string' && k ? k : undefined;
  } catch (e) {
    return undefined;
  }
}

export async function exportNode(node: SceneNode, opts: Options, sink: Sink): Promise<Json> {
  const ctx = new Ctx(node, opts, sink);
  ctx.progress('Reading "' + node.name + '"…');
  const spec = await walk(ctx, node, null);
  ctx.progress('Read ' + ctx.count + ' layers, ' + ctx.files.length + ' icon/image file(s)');
  const prototype = await prototypeOf(ctx, node);
  if (opts.css && ctx.cssQueue.length) await addCss(ctx);

  ctx.progress('Rendering the frame preview…');
  // useAbsoluteBounds: render exactly the node's box (default would crop to visible content
  // or grow for shadows/overflow), so screenshot pixel = spec coordinate × scale.
  let scale = opts.scale;
  let png: Uint8Array;
  try {
    png = await node.exportAsync({ format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'SCALE', value: scale } });
  } catch (e) {
    ctx.warnings.push('PNG export at ' + scale + 'x failed (' + errMsg(e) + '), used 1x');
    scale = 1;
    png = await node.exportAsync({ format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'SCALE', value: 1 } });
  }
  const screen = 'screen@' + scale + 'x.png';
  ctx.emit(screen, png);

  return {
    meta: {
      tool: 'figma-lens',
      version: VERSION,
      file: figma.root.name,
      fileKey: fileKeyOf(),
      page: pageNameOf(node) || figma.currentPage.name, // the frame's own page (a link can point at another page)
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      width: r2(node.width),
      height: r2(node.height),
      scale,
      screen,
      sections: opts.sections ? pickSections(ctx, node) : [],
      prototype,
      nodeCount: ctx.count,
      truncated: ctx.truncated,
      maxLayers: opts.maxLayers,
      skipped: ctx.skipped,
      skippedCount: ctx.skippedCount,
      css: opts.css ? { limit: opts.cssLimit, added: ctx.cssCount, candidates: ctx.cssQueue.length } : null,
      warnings: ctx.warnings,
      exportedAt: new Date().toISOString(),
    },
    spec,
    tokens: { variables: ctx.variables, styles: ctx.styles },
    files: ctx.files,
  };
}
