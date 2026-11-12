import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const formStart = page.indexOf('id="patron-desk-message"');
assert.notEqual(formStart, -1, "missing Write to the House form");
const formEnd = page.indexOf("</form>", formStart);
const form = page.slice(formStart, formEnd);
const scriptAt = page.indexOf("async function sendDeskMessage");
assert.notEqual(scriptAt, -1);
const script = page.slice(scriptAt, page.indexOf("async function enrollRecoveryEmail", scriptAt));

test("the desk form is hidden until sign-in and only sends a message", () => {
  assert.match(form, /class="hidden /);
  assert.match(form, /Write to the House/);
  assert.match(form, /id="patron-desk-text"/);
  assert.match(form, /maxlength="2000"/);
  assert.doesNotMatch(form, /name="handle"/);
  assert.doesNotMatch(form, /id="patron-desk-handle"/);
  assert.match(script, /VERIFY_API \+ '\/patron\/desk-message'/);
  assert.match(script, /JSON\.stringify\(\{ message: message \}\)/);
  assert.doesNotMatch(script, /handle:/);
  assert.match(page, /patron-desk-message'\)\.classList\.remove\('hidden'\)/);
  assert.match(page, /patron-desk-message[\s\S]{0,80}classList\.add\('hidden'\)/);
});
