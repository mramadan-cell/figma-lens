// Prototype timing units and unattended-run tool limits. (The check verdict is tested in compare.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerStr, msStr } from '../bridge/render-md.js';
import { DEFAULT_ALLOWED_TOOLS } from '../tools/auto.js';

test('prototype trigger timing is in milliseconds (Figma Plugin API)', () => {
  assert.equal(msStr(300), '300ms');
  assert.equal(msStr(1500), '1.5s');
  assert.equal(triggerStr({ type: 'AFTER_TIMEOUT', timeout: 800 }), 'after delay 800ms');
  assert.match(triggerStr({ type: 'MOUSE_ENTER', delay: 2000 }), /\(delay 2s\)$/);
});

test('auto allows the read-only helpers real runs were denied (grep, sed, git log/show; never find, whose -exec/-delete get around the denials)', () => {
  for (const t of ['Bash(grep:*)', 'Bash(sed:*)', 'Bash(git log:*)', 'Bash(git show:*)']) assert.ok(DEFAULT_ALLOWED_TOOLS.includes(t), t);
  for (const t of ['Bash(rm:*)', 'Bash(git commit:*)', 'Bash(curl:*)', 'Bash(find:*)']) assert.ok(!DEFAULT_ALLOWED_TOOLS.includes(t), t);
});
