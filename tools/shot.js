// Screenshot the built UI: a web page (also Flutter web) via the installed Edge/Chrome,
// or an Android device/emulator (Flutter mobile) via adb.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function shotWeb({ url, width, height, scale = 2, out, fullPage = false, waitMs = 800, channel }) {
  if (!url) throw new Error('shot needs --url');
  let pw;
  try {
    pw = await import('playwright-core');
  } catch {
    throw new Error('playwright-core is not installed; run npm install in the figma-lens folder');
  }
  const channels = channel ? [channel] : ['msedge', 'chrome'];
  let browser;
  let lastErr;
  for (const ch of channels) {
    try {
      browser = await pw.chromium.launch({ channel: ch });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!browser) {
    throw new Error(`no Edge or Chrome found to render your build (${String(lastErr && lastErr.message).split('\n')[0]}). Install one, or pass --channel chrome|msedge`);
  }
  try {
    const page = await browser.newPage({ viewport: { width: Math.round(width), height: Math.round(height) }, deviceScaleFactor: scale });
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    // Dev servers keep live-reload connections open, so "network idle" may never come: wait briefly, then go on.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(waitMs); // fonts, images, entry animations
    await page.screenshot({ path: out, fullPage });
  } finally {
    await browser.close();
  }
  return out;
}

export function shotAdb({ out, serial }) {
  const args = [...(serial ? ['-s', serial] : []), 'exec-out', 'screencap', '-p'];
  const r = spawnSync('adb', args, { maxBuffer: 128 * 1024 * 1024 });
  if (r.error) throw new Error(`adb not found (${r.error.message}). Install Android platform-tools or add adb to PATH`);
  if (r.status !== 0) throw new Error(`adb failed: ${String(r.stderr).trim() || 'exit ' + r.status}`);
  if (!r.stdout || r.stdout[0] !== 0x89) throw new Error('adb did not return a PNG (is a device/emulator connected and unlocked?)');
  fs.writeFileSync(out, r.stdout);
  return out;
}
