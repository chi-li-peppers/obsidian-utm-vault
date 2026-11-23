// Unit tests for UTM Vault. Run with: node tests/run.js
const Module = require("module");
const assert = require("assert");

const fake = {
  Plugin: class { async saveData() {} async loadData() { return {}; } },
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {},
  Modal: class {},
  TFile: class {},
  normalizePath: (p) => String(p).replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "obsidian" ? fake : origLoad.call(this, req, ...rest);
};

const P = require(require("path").join(__dirname, "..", "main.js"));
const I = P._internals;

async function main() {
  // --- normalizeUtmValue
  assert.strictEqual(I.normalizeUtmValue("  Spring Launch 2026!  "), "spring-launch-2026!");
  assert.strictEqual(I.normalizeUtmValue("Paid   Social", { separator: "_" }), "paid_social");
  assert.strictEqual(I.normalizeUtmValue("Meta Ads", { lowercase: false }), "Meta-Ads");
  assert.strictEqual(I.normalizeUtmValue("a?b&c=d#e"), "a-b-c-d-e");
  console.log("normalize ok");

  // --- buildUtmUrl (preserves query params & hash, overwrites old UTMs, auto-https)
  const b1 = I.buildUtmUrl("example.com/pricing?ref=partner#annual", {
    source: "Google",
    medium: "CPC",
    campaign: "Spring Launch",
    content: "Hero CTA",
  });
  assert.strictEqual(
    b1.url,
    "https://example.com/pricing?ref=partner&utm_source=google&utm_medium=cpc&utm_campaign=spring-launch&utm_content=hero-cta#annual"
  );

  // Overwriting existing UTM params must not duplicate them
  const b2 = I.buildUtmUrl("https://example.com/?utm_source=old&foo=1", {
    utm_source: "meta",
    utm_medium: "paid-social",
    utm_campaign: "retarget",
  });
  const parsed2 = new URL(b2.url);
  assert.deepStrictEqual(parsed2.searchParams.getAll("utm_source"), ["meta"]);
  assert.strictEqual(parsed2.searchParams.get("foo"), "1");
  assert.throws(() => I.buildUtmUrl("javascript:alert(1)", { source: "a" }));
  console.log("build ok");

  // --- parseUtmUrl
  const p = I.parseUtmUrl(b1.url);
  assert.strictEqual(p.valid, true);
  assert.strictEqual(p.baseUrl, "https://example.com/pricing?ref=partner#annual");
  assert.strictEqual(p.params.utm_source, "google");
  assert.strictEqual(p.params.utm_campaign, "spring-launch");
  console.log("parse ok");

  // --- validateUtm
  const existing = new Set([b1.url]);
  const v1 = I.validateUtm(
    "example.com/pricing?ref=partner#annual",
    { source: "Google", medium: "CPC", campaign: "Spring Launch", content: "Hero CTA" },
    { lowercase: true, separator: "-", allowedSources: "meta, linkedin", allowedMediums: "cpc" },
    existing
  );
  assert.strictEqual(v1.errors.length, 0);
  assert.strictEqual(v1.warnings.length, 2); // non-allowed source + duplicate
  const v2 = I.validateUtm("not a url", {}, {}, existing);
  assert.ok(v2.errors.length >= 4);
  console.log("validate ok");

  // --- auditMarkdownLinks
  const doc = [
    "Good: [Pricing](https://example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand)",
    "Bad case: https://example.com/?utm_source=Google&utm_medium=cpc&utm_campaign=brand",
    "Missing camp: https://example.com/?utm_source=meta&utm_medium=paid-social",
    "Duplicate: https://example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand",
    "Non-UTM ignored: https://example.com/about",
  ].join("\n");
  const audit = I.auditMarkdownLinks(doc, { lowercase: true, allowedSources: "google, meta" });
  assert.strictEqual(audit.length, 4);
  assert.strictEqual(audit[0].status, "ok");
  assert.strictEqual(audit[1].status, "warn");
  assert.strictEqual(audit[2].status, "error");
  assert.strictEqual(audit[3].status, "warn");
  console.log("audit ok");

  // --- registry, link note & Bases .base generator
  const entry = {
    date: "2026-11-24",
    label: "Hero | CTA",
    baseUrl: "https://example.com/pricing",
    url: b1.url,
    params: b1.params,
  };
  const reg1 = I.appendToRegistryMarkdown("", entry);
  assert.ok(reg1.includes("| Date | Label | Source |"));
  assert.ok(reg1.includes("Hero \\| CTA"));
  const extracted = I.extractUrlsFromRegistry(reg1);
  assert.ok(extracted.has(b1.url));

  const noteMd = I.buildLinkNoteContent(entry);
  assert.ok(noteMd.includes('utm_source: "google"'));
  assert.ok(noteMd.includes(`utm_url: "${b1.url}"`));

  const baseFile = I.buildBaseFileContent("UTM Links");
  assert.ok(baseFile.includes('file.inFolder("UTM Links")'));
  assert.ok(baseFile.includes("utm_campaign"));
  console.log("registry & bases ok");

  console.log("all tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
