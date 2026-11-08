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

const recover = sliceBetween(page, 'id="vip-form-recover"', "</form>");
const login = sliceBetween(page, 'id="vip-form-login"', "</form>");
const apply = sliceBetween(page, 'id="hotm-apply-form"', "</form>");
const engineAt = page.indexOf("const VERIFY_API");
assert.notEqual(engineAt, -1, "missing VERIFY_API");
const engineStart = page.lastIndexOf("<script>", engineAt);
const engineEnd = page.indexOf("</script>", engineAt);
assert.ok(engineStart !== -1 && engineEnd !== -1, "missing engine script");
const script = page.slice(engineStart, engineEnd);

test("recover form asks for a handle and not an email destination", () => {
  assert.match(recover, /data-recovery="handle-only"/);
  assert.match(recover, /verified email stored for that court key/i);
  assert.match(recover, /does not take an email address/i);
  assert.match(recover, /id="vip-recover-handle"/);
  assert.match(recover, /name="handle"/);
  assert.doesNotMatch(recover, /type="email"/i);
  assert.doesNotMatch(recover, /applied with/i);
  assert.match(script, /JSON\.stringify\(\{\s*handle:\s*handle\s*\}\)/);
  assert.match(script, /\/patron\/recovery\/request/);
  assert.match(script, /JSON\.stringify\(\{\s*token:\s*hotmResetToken,\s*passcode:\s*pass\s*\}\)/);
  assert.doesNotMatch(script, /\/patron\/recovery\/complete\?/);
  assert.match(script, /JSON\.stringify\(\{\s*email:\s*email,\s*passcode:\s*passcode\s*\}\)/);
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
    /We keep only your handle, status \(approved\/rejected\/expired\), and dates\. The email on this form is not kept as a login or recovery address\./,
  );
  assert.match(
    page,
    /A recovery email is separate\./,
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
