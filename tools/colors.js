// Terminal colors, no dependencies. Colors only when writing to a real terminal; never in pipes,
// log files or tests. NO_COLOR=1 turns them off, FORCE_COLOR=1 forces them on (https://no-color.org).
const env = process.env;

export function colorEnabled() {
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
  return !!(process.stdout && process.stdout.isTTY);
}

const wrap = (open, close) => (s) => (colorEnabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** A Figma-match score, colored by how close it is: ≤3% green, ≤10% yellow, else red. */
export function pct(n) {
  const v = Number(n);
  const paint = v <= 3 ? c.green : v <= 10 ? c.yellow : c.red;
  return paint(`${n}%`);
}

/** Remove color codes (for tests and for widths). */
export const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
