/**
 * Fail-closed checks for the live patron gate (static GitHub Pages page).
 *
 * The account system is the hotm-verify Worker, which is not in this
 * repository. The page must not collect a recovery address, build a reset
 * link, or treat the Audience Desk contact email as an account binding.
 * Run: node --test tests/patron-recovery-surface.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const recover = sliceBetween(page, 'id="vip-form-recover"', "</div>");
const login = sliceBetween(page, 'id="vip-form-login"', "</form>");
const apply = sliceBetween(page, 'id="hotm-apply-form"', "</form>");
const engineAt = page.indexOf("const VERIFY_API");
assert.notEqual(engineAt, -1, "missing VERIFY_API");
const engineStart = page.lastIndexOf("<script>", engineAt);
const engineEnd = page.indexOf("</script>", engineAt);
assert.ok(engineStart !== -1 && engineEnd !== -1, "missing engine script");
const script = page.slice(engineStart, engineEnd);

test("recover panel is closed and collects no destination", () => {
  assert.match(recover, /data-recovery="closed"/);
  assert.match(recover, /verified email the house already stores for that account/i);
  assert.match(recover, /no verified email on file/i);
  assert.match(recover, /enrolled while signed in/i);
  assert.doesNotMatch(recover, /<input\b/i);
  assert.doesNotMatch(recover, /<form\b/i);
  assert.doesNotMatch(recover, /<button\b/i);
  assert.doesNotMatch(recover, /type\s*=\s*["']email["']/i);
  assert.doesNotMatch(recover, /applied with/i);
  assert.doesNotMatch(recover, /request a new one/i);
  assert.match(recover, /leaves ID approval, Vault access, and the court key unchanged/i);
});

test("page script does not request or assemble a reset link", () => {
  assert.doesNotMatch(script, /\/patron\/recover/i);
  assert.doesNotMatch(script, /\/patron\/recovery/i);
  assert.doesNotMatch(script, /\/password\/reset/i);
  assert.doesNotMatch(script, /resetToken|recoveryToken|forgot/i);
  assert.doesNotMatch(script, /vip-form-recover[\s\S]{0,400}fetch\s*\(/i);
  assert.match(script, /async function handleVIPLogin\(/);
  assert.match(script, /function handleVIPApply\(/);
});

test("sign-in still posts only handle and passcode to the verify Worker", () => {
  assert.match(login, /id="vip-login-handle"/);
  assert.match(login, /id="vip-login-pass"/);
  assert.match(login, /autocomplete="current-password"/);
  assert.doesNotMatch(login, /type="email"/);
  assert.match(
    script,
    /fetch\(VERIFY_API \+ '\/patron\/login',\s*\{\s*method:\s*'POST',\s*headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\},\s*body:\s*JSON\.stringify\(\{\s*handle,\s*passcode\s*\}\)\s*\}/,
  );
  assert.match(page, /const VERIFY_API = "https:\/\/hotm-verify\.mistressolera\.workers\.dev"/);
});

test("application email stays on the ID form and is not described as a retained login binding", () => {
  assert.match(apply, /name="email"/);
  assert.match(apply, /name="id_image"/);
  assert.match(apply, /name="selfie"/);
  assert.match(apply, /name="handle"/);
  assert.match(apply, /name="consent"/);
  assert.match(
    page,
    /We keep only your handle, status \(approved\/rejected\/expired\), and dates\./,
  );
  assert.doesNotMatch(recover, /name="email"/);
});

test("booking desk, Throne, and Daybook hooks are unchanged", () => {
  assert.match(
    page,
    /https:\/\/script\.google\.com\/macros\/s\/AKfycbxqieZjKlqL_4WbOBQL_EGuYa4d4TS2L7tZo0yGIjwXt-mBH-1_MTul98cmVHReQEhHBg\/exec/,
  );
  assert.match(page, /https:\/\/throne\.com\/mistresssolena\/collections\/100-crescent-patronage/);
  assert.match(page, /https:\/\/throne\.com\/mistresssolena\/collections\/200-lunar-patronage/);
  assert.match(page, /function hotmOpenDeposit\(event\)/);
  assert.match(page, /bc1qgpncqpes2premlxy7kfdm67nfphjd00x9x7dzz/);
});
