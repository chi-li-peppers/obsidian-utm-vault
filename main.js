"use strict";

const obsidian = require("obsidian");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  TFile,
  normalizePath,
} = obsidian;

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_PRESETS = [
  { name: "Google Ads (Search)", source: "google", medium: "cpc" },
  { name: "Google Ads (Display)", source: "google", medium: "display" },
  { name: "Meta Ads", source: "meta", medium: "paid-social" },
  { name: "YouTube", source: "youtube", medium: "video" },
  { name: "LinkedIn Ads", source: "linkedin", medium: "paid-social" },
  { name: "Newsletter", source: "newsletter", medium: "email" },
  { name: "X / Twitter", source: "x", medium: "social" },
  { name: "Reddit", source: "reddit", medium: "social" },
  { name: "Partner / Affiliate", source: "partner", medium: "affiliate" },
];

const DEFAULT_SETTINGS = {
  defaultBaseUrl: "",
  lowercase: true,
  separator: "-", // "-" | "_"
  autoSaveOnCopy: true,
  saveToTable: true,
  registryPath: "UTM Registry.md",
  createNotePerLink: false,
  notesFolder: "UTM Links",
  allowedSources: "",
  allowedMediums: "",
  presets: DEFAULT_PRESETS,
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"];

/* ------------------------------------------------------------------ */
/* Core UTM Engine                                                     */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, "0");
}
function todayYmd(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
function escapeCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function parseCsvList(str) {
  return String(str || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Normalise a UTM parameter value according to naming rules.
 */
function normalizeUtmValue(val, opts = {}) {
  let s = String(val ?? "").trim();
  if (!s) return "";
  const sep = opts.separator === "_" ? "_" : "-";
  if (opts.lowercase !== false) s = s.toLowerCase();
  // Replace whitespace and stray query delimiters with the chosen separator.
  s = s.replace(/[\s?&=#]+/g, sep);
  // Collapse repeated separators and trim edges.
  const esc = sep === "-" ? "-" : "_";
  const multiRe = new RegExp(`${esc}{2,}`, "g");
  const edgeRe = new RegExp(`^${esc}+|${esc}+$`, "g");
  return s.replace(multiRe, sep).replace(edgeRe, "");
}

/**
 * Normalise and parse a base URL string. Prepends https:// when user omits protocol on a valid host.
 */
function parseBaseUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(s)) {
      s = "https://" + s;
    } else {
      return null;
    }
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch (e) {
    return null;
  }
}

/**
 * Build a clean UTM tracking URL, preserving existing non-UTM query params and hash fragments.
 */
function buildUtmUrl(baseUrl, params = {}, opts = {}) {
  const u = parseBaseUrl(baseUrl);
  if (!u) throw new Error("Enter a valid http:// or https:// URL");

  // Remove any previous UTM params so we never duplicate them.
  for (const k of UTM_KEYS) u.searchParams.delete(k);

  const normalized = {};
  for (const k of UTM_KEYS) {
    const raw = params[k] ?? params[k.replace("utm_", "")] ?? "";
    const val = opts.skipNormalize ? String(raw).trim() : normalizeUtmValue(raw, opts);
    normalized[k] = val;
    if (val) u.searchParams.set(k, val);
  }
  return { url: u.toString(), params: normalized };
}

/**
 * Parse an existing URL into baseUrl (without UTM params) and its UTM parameters.
 */
function parseUtmUrl(urlStr) {
  const u = parseBaseUrl(urlStr);
  if (!u) return { valid: false, url: String(urlStr || ""), baseUrl: "", params: {} };
  const params = {};
  for (const k of UTM_KEYS) {
    params[k] = u.searchParams.get(k) || "";
  }
  const clean = new URL(u.toString());
  for (const k of UTM_KEYS) clean.searchParams.delete(k);
  return { valid: true, url: u.toString(), baseUrl: clean.toString(), params };
}

/**
 * Validate a UTM link against GA4 requirements, configured naming rules and duplicate registry URLs.
 */
function validateUtm(baseUrl, params = {}, settings = {}, existingUrls = new Set()) {
  const errors = [];
  const warnings = [];
  const u = parseBaseUrl(baseUrl);
  if (!u) errors.push("Base URL is missing or invalid.");

  const src = String(params.utm_source ?? params.source ?? "").trim();
  const med = String(params.utm_medium ?? params.medium ?? "").trim();
  const camp = String(params.utm_campaign ?? params.campaign ?? "").trim();

  if (!src) errors.push("utm_source is required.");
  if (!med) errors.push("utm_medium is required.");
  if (!camp) errors.push("utm_campaign is required.");

  const allowedSrc = parseCsvList(settings.allowedSources);
  const allowedMed = parseCsvList(settings.allowedMediums);
  const normOpts = { lowercase: settings.lowercase !== false, separator: settings.separator || "-" };
  const normSrc = normalizeUtmValue(src, normOpts);
  const normMed = normalizeUtmValue(med, normOpts);

  if (allowedSrc.length && normSrc && !allowedSrc.includes(normSrc.toLowerCase())) {
    warnings.push(`Source "${normSrc}" is not in allowed sources (${allowedSrc.join(", ")}).`);
  }
  if (allowedMed.length && normMed && !allowedMed.includes(normMed.toLowerCase())) {
    warnings.push(`Medium "${normMed}" is not in allowed mediums (${allowedMed.join(", ")}).`);
  }

  let builtUrl = "";
  if (u) {
    builtUrl = buildUtmUrl(baseUrl, params, normOpts).url;
    if (existingUrls && existingUrls.has(builtUrl)) {
      warnings.push("This exact UTM link already exists in your registry.");
    }
  }

  return { errors, warnings, url: builtUrl };
}

/**
 * Audit all UTM links found inside a Markdown document.
 */
function auditMarkdownLinks(markdown, settings = {}) {
  const re = /https?:\/\/[^\s)>"'`\]]+/gi;
  const matches = String(markdown || "").match(re) || [];
  const seen = new Set();
  const results = [];
  const allowedSrc = parseCsvList(settings.allowedSources);
  const allowedMed = parseCsvList(settings.allowedMediums);

  for (const rawMatch of matches) {
    const cleanRaw = rawMatch.replace(/[.,;:!?]+$/, "");
    if (!/[?&]utm_/i.test(cleanRaw)) continue;
    const parsed = parseUtmUrl(cleanRaw);
    if (!parsed.valid) continue;

    const issues = [];
    const p = parsed.params;
    if (!p.utm_source) issues.push({ level: "error", msg: "Missing utm_source" });
    if (!p.utm_medium) issues.push({ level: "error", msg: "Missing utm_medium" });
    if (!p.utm_campaign) issues.push({ level: "error", msg: "Missing utm_campaign" });

    for (const k of UTM_KEYS) {
      const v = p[k];
      if (!v) continue;
      if (settings.lowercase !== false && v !== v.toLowerCase()) {
        issues.push({ level: "warn", msg: `${k} has uppercase characters ("${v}")` });
      }
      if (/\s/.test(v)) {
        issues.push({ level: "warn", msg: `${k} contains spaces ("${v}")` });
      }
    }

    if (allowedSrc.length && p.utm_source && !allowedSrc.includes(p.utm_source.toLowerCase())) {
      issues.push({ level: "warn", msg: `Non-standard utm_source "${p.utm_source}"` });
    }
    if (allowedMed.length && p.utm_medium && !allowedMed.includes(p.utm_medium.toLowerCase())) {
      issues.push({ level: "warn", msg: `Non-standard utm_medium "${p.utm_medium}"` });
    }
    if (seen.has(parsed.url)) {
      issues.push({ level: "warn", msg: "Duplicate UTM URL in this note" });
    }
    seen.add(parsed.url);

    const status = issues.some((x) => x.level === "error")
      ? "error"
      : issues.some((x) => x.level === "warn")
        ? "warn"
        : "ok";
    results.push({ url: parsed.url, params: p, status, issues });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Registry & Bases helpers                                            */
/* ------------------------------------------------------------------ */

const REGISTRY_HEADER =
  "# UTM Registry\n\n" +
  "| Date | Label | Source | Medium | Campaign | Content | Term | Link |\n" +
  "| --- | --- | --- | --- | --- | --- | --- | --- |\n";

function formatRegistryRow(entry) {
  const cells = [
    escapeCell(entry.date || todayYmd()),
    escapeCell(entry.label || ""),
    escapeCell(entry.params.utm_source || ""),
    escapeCell(entry.params.utm_medium || ""),
    escapeCell(entry.params.utm_campaign || ""),
    escapeCell(entry.params.utm_content || ""),
    escapeCell(entry.params.utm_term || ""),
    `[Open](${entry.url})`,
  ];
  return `| ${cells.join(" | ")} |`;
}

function appendToRegistryMarkdown(existing, entry) {
  const row = formatRegistryRow(entry);
  if (!existing || !existing.trim()) {
    return `${REGISTRY_HEADER}${row}\n`;
  }
  const trimmed = existing.replace(/\s+$/, "");
  return `${trimmed}\n${row}\n`;
}

function extractUrlsFromRegistry(markdown) {
  const set = new Set();
  const re = /https?:\/\/[^\s)>"'`\]]+/gi;
  for (const m of String(markdown || "").match(re) || []) {
    set.add(m.replace(/[.,;:!?]+$/, ""));
  }
  return set;
}

function sanitizeFileName(name) {
  return String(name || "utm-link")
    .replace(/[\\/:*?"<>|#^\[\]]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "utm-link";
}

function yamlStr(v) {
  const s = String(v ?? "");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

function buildLinkNoteContent(entry) {
  const p = entry.params;
  const lines = [
    "---",
    `utm_created: ${entry.date || todayYmd()}`,
    `utm_label: ${yamlStr(entry.label || p.utm_campaign || "")}`,
    `utm_source: ${yamlStr(p.utm_source || "")}`,
    `utm_medium: ${yamlStr(p.utm_medium || "")}`,
    `utm_campaign: ${yamlStr(p.utm_campaign || "")}`,
    `utm_content: ${yamlStr(p.utm_content || "")}`,
    `utm_term: ${yamlStr(p.utm_term || "")}`,
    `utm_id: ${yamlStr(p.utm_id || "")}`,
    `utm_base_url: ${yamlStr(entry.baseUrl || "")}`,
    `utm_url: ${yamlStr(entry.url || "")}`,
    "tags:",
    "  - utm",
    "---",
    "",
    `# ${entry.label || p.utm_campaign || "UTM Link"}`,
    "",
    `- **Tracking URL:** ${entry.url}`,
    `- **Destination:** ${entry.baseUrl}`,
    `- **Channel:** \`${p.utm_source || ""}\` / \`${p.utm_medium || ""}\``,
    "",
  ];
  return lines.join("\n");
}

function buildBaseFileContent(folder) {
  const cleanFolder = String(folder || "UTM Links").replace(/^\/+|\/+$/g, "");
  return [
    "filters:",
    "  and:",
    `    - 'file.inFolder("${cleanFolder}")'`,
    "views:",
    "  - type: table",
    "    name: All UTM Links",
    "    order:",
    "      - utm_created",
    "      - utm_label",
    "      - utm_source",
    "      - utm_medium",
    "      - utm_campaign",
    "      - utm_content",
    "      - utm_url",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class UtmVaultPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("link", "Build UTM link", () => {
      this.openBuilder();
    });

    this.addCommand({
      id: "build-utm-link",
      name: "Build UTM link",
      callback: () => this.openBuilder(),
    });

    this.addCommand({
      id: "insert-utm-link",
      name: "Insert UTM link at cursor",
      editorCallback: (editor) => this.openBuilder({ editor }),
    });

    this.addCommand({
      id: "parse-utm-from-clipboard",
      name: "Parse and edit UTM link from clipboard",
      callback: async () => {
        let clip = "";
        try {
          clip = await navigator.clipboard.readText();
        } catch (e) {
          clip = "";
        }
        const parsed = parseUtmUrl(clip);
        if (!parsed.valid) {
          new Notice("UTM Vault: no valid URL found in clipboard");
          this.openBuilder();
          return;
        }
        this.openBuilder({ initial: parsed });
      },
    });

    this.addCommand({
      id: "audit-utm-in-note",
      name: "Audit UTM links in current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.auditActiveNote(file);
        return true;
      },
    });

    this.addCommand({
      id: "open-utm-registry",
      name: "Open UTM registry",
      callback: () => this.openRegistry(),
    });

    this.addCommand({
      id: "create-utm-base",
      name: "Create Obsidian Base view (.base) for UTM links",
      callback: () => this.createBaseFile(),
    });

    this.addSettingTab(new UtmVaultSettingTab(this.app, this));
  }

  async loadSettings() {
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!Array.isArray(this.settings.presets) || !this.settings.presets.length) {
      this.settings.presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async getExistingUrls() {
    const urls = new Set();
    const regPath = normalizePath(this.settings.registryPath || "UTM Registry.md");
    const regFile = this.app.vault.getAbstractFileByPath(regPath);
    if (regFile instanceof TFile) {
      const content = await this.app.vault.read(regFile);
      for (const u of extractUrlsFromRegistry(content)) urls.add(u);
    }
    return urls;
  }

  async openBuilder(opts = {}) {
    const existingUrls = await this.getExistingUrls();
    new UtmBuilderModal(this.app, this, { ...opts, existingUrls }).open();
  }

  async saveEntry(entry) {
    let savedWhere = [];

    if (this.settings.saveToTable) {
      const regPath = normalizePath(this.settings.registryPath || "UTM Registry.md");
      const folder = regPath.includes("/") ? regPath.slice(0, regPath.lastIndexOf("/")) : "";
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const existingFile = this.app.vault.getAbstractFileByPath(regPath);
      if (existingFile instanceof TFile) {
        await this.app.vault.process(existingFile, (data) => appendToRegistryMarkdown(data, entry));
      } else {
        await this.app.vault.create(regPath, appendToRegistryMarkdown("", entry));
      }
      savedWhere.push(regPath);
    }

    if (this.settings.createNotePerLink) {
      const folder = normalizePath((this.settings.notesFolder || "UTM Links").replace(/^\/+|\/+$/g, ""));
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const baseName = sanitizeFileName(
        `${entry.date || todayYmd()} ${entry.params.utm_source || ""} ${entry.params.utm_campaign || entry.label || "link"}`
      );
      let target = normalizePath(`${folder}/${baseName}.md`);
      let n = 2;
      while (this.app.vault.getAbstractFileByPath(target)) {
        target = normalizePath(`${folder}/${baseName}-${n++}.md`);
      }
      await this.app.vault.create(target, buildLinkNoteContent(entry));
      savedWhere.push(target);
    }

    return savedWhere;
  }

  async openRegistry() {
    const regPath = normalizePath(this.settings.registryPath || "UTM Registry.md");
    let file = this.app.vault.getAbstractFileByPath(regPath);
    if (!(file instanceof TFile)) {
      const folder = regPath.includes("/") ? regPath.slice(0, regPath.lastIndexOf("/")) : "";
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      file = await this.app.vault.create(regPath, REGISTRY_HEADER);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async createBaseFile() {
    const folder = (this.settings.notesFolder || "UTM Links").replace(/^\/+|\/+$/g, "");
    const basePath = normalizePath(`${folder}.base`);
    const content = buildBaseFileContent(folder);
    const existing = this.app.vault.getAbstractFileByPath(basePath);
    if (existing instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(existing);
      new Notice(`UTM Vault: opened existing ${basePath}`);
      return;
    }
    const created = await this.app.vault.create(basePath, content);
    await this.app.workspace.getLeaf(false).openFile(created);
    new Notice(`UTM Vault: created ${basePath}`);
  }

  async auditActiveNote(file) {
    const content = await this.app.vault.read(file);
    const results = auditMarkdownLinks(content, this.settings);
    if (!results.length) {
      new Notice("UTM Vault: no UTM links found in this note");
      return;
    }
    new UtmAuditModal(this.app, file.basename, results).open();
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

class UtmBuilderModal extends Modal {
  constructor(app, plugin, opts = {}) {
    super(app);
    this.plugin = plugin;
    this.editor = opts.editor || null;
    this.existingUrls = opts.existingUrls || new Set();
    const init = opts.initial || {};
    this.state = {
      baseUrl: init.baseUrl || plugin.settings.defaultBaseUrl || "",
      label: "",
      utm_source: init.params?.utm_source || "",
      utm_medium: init.params?.utm_medium || "",
      utm_campaign: init.params?.utm_campaign || "",
      utm_content: init.params?.utm_content || "",
      utm_term: init.params?.utm_term || "",
      utm_id: init.params?.utm_id || "",
    };
    this.inputs = {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Build UTM link" });

    // Channel presets
    const presetBar = contentEl.createDiv({ cls: "utm-vault-presets" });
    const presetButtons = [];
    for (const p of this.plugin.settings.presets) {
      const btn = presetBar.createEl("button", { cls: "utm-vault-preset-btn", text: p.name });
      btn.addEventListener("click", () => {
        this.state.utm_source = p.source;
        this.state.utm_medium = p.medium;
        if (this.inputs.utm_source) this.inputs.utm_source.setValue(p.source);
        if (this.inputs.utm_medium) this.inputs.utm_medium.setValue(p.medium);
        for (const b of presetButtons) b.removeClass("is-active");
        btn.addClass("is-active");
        this.refreshPreview();
      });
      presetButtons.push(btn);
    }

    const addField = (key, name, placeholder, desc) => {
      const setting = new Setting(contentEl).setName(name);
      if (desc) setting.setDesc(desc);
      setting.addText((t) => {
        this.inputs[key] = t;
        t.setPlaceholder(placeholder || "")
          .setValue(this.state[key])
          .onChange((v) => {
            this.state[key] = v;
            this.refreshPreview();
          });
      });
    };

    addField("baseUrl", "Destination URL", "https://example.com/landing", "Existing query params and #anchors are preserved.");
    addField("label", "Label (optional)", "Black Friday hero CTA");
    addField("utm_source", "Source (utm_source)", "google, meta, newsletter");
    addField("utm_medium", "Medium (utm_medium)", "cpc, paid-social, email");
    addField("utm_campaign", "Campaign (utm_campaign)", "spring-launch-2026");
    addField("utm_content", "Content (utm_content)", "optional — ad creative or link placement");
    addField("utm_term", "Term (utm_term)", "optional — paid keyword");
    addField("utm_id", "Campaign ID (utm_id)", "optional");

    this.previewEl = contentEl.createDiv({ cls: "utm-vault-preview" });
    this.messagesEl = contentEl.createDiv({ cls: "utm-vault-messages" });

    const actions = contentEl.createDiv({ cls: "utm-vault-actions" });

    const runAction = async (mode) => {
      const v = validateUtm(this.state.baseUrl, this.state, this.plugin.settings, this.existingUrls);
      if (v.errors.length) {
        new Notice(`UTM Vault: ${v.errors[0]}`, 6000);
        return;
      }
      const normOpts = {
        lowercase: this.plugin.settings.lowercase !== false,
        separator: this.plugin.settings.separator || "-",
      };
      const built = buildUtmUrl(this.state.baseUrl, this.state, normOpts);
      const entry = {
        date: todayYmd(),
        label: this.state.label.trim(),
        baseUrl: parseBaseUrl(this.state.baseUrl).toString(),
        url: built.url,
        params: built.params,
      };

      const shouldSave = mode === "save" || this.plugin.settings.autoSaveOnCopy;
      if (shouldSave && !this.existingUrls.has(entry.url)) {
        await this.plugin.saveEntry(entry);
        this.existingUrls.add(entry.url);
      }

      if (mode === "copy") {
        await navigator.clipboard.writeText(entry.url);
        new Notice(shouldSave ? "UTM Vault: copied URL and saved to registry" : "UTM Vault: copied URL");
        this.close();
      } else if (mode === "copy-md") {
        const md = `[${entry.label || entry.params.utm_campaign || entry.url}](${entry.url})`;
        await navigator.clipboard.writeText(md);
        new Notice(shouldSave ? "UTM Vault: copied Markdown link and saved" : "UTM Vault: copied Markdown link");
        this.close();
      } else if (mode === "insert" && this.editor) {
        const text = entry.label ? `[${entry.label}](${entry.url})` : entry.url;
        this.editor.replaceSelection(text);
        new Notice(shouldSave ? "UTM Vault: inserted and saved to registry" : "UTM Vault: inserted");
        this.close();
      } else if (mode === "save") {
        new Notice("UTM Vault: saved to registry");
        this.refreshPreview();
      }
    };

    const saveBtn = actions.createEl("button", { text: "Save to registry" });
    saveBtn.addEventListener("click", () => runAction("save"));

    const copyMdBtn = actions.createEl("button", { text: "Copy Markdown" });
    copyMdBtn.addEventListener("click", () => runAction("copy-md"));

    const copyBtn = actions.createEl("button", { text: "Copy URL", cls: this.editor ? "" : "mod-cta" });
    copyBtn.addEventListener("click", () => runAction("copy"));

    if (this.editor) {
      const insertBtn = actions.createEl("button", { text: "Insert at cursor", cls: "mod-cta" });
      insertBtn.addEventListener("click", () => runAction("insert"));
    }

    this.refreshPreview();
  }

  refreshPreview() {
    const v = validateUtm(this.state.baseUrl, this.state, this.plugin.settings, this.existingUrls);
    this.previewEl.empty();
    if (v.url) {
      this.previewEl.removeClass("is-empty");
      this.previewEl.setText(v.url);
    } else {
      this.previewEl.addClass("is-empty");
      this.previewEl.setText("Enter a destination URL to preview your tracking link…");
    }

    this.messagesEl.empty();
    for (const err of v.errors) {
      this.messagesEl.createDiv({ cls: "utm-vault-msg-error", text: `🔴 ${err}` });
    }
    for (const warn of v.warnings) {
      this.messagesEl.createDiv({ cls: "utm-vault-msg-warn", text: `⚠️ ${warn}` });
    }
  }
}

class UtmAuditModal extends Modal {
  constructor(app, noteName, results) {
    super(app);
    this.noteName = noteName;
    this.results = results;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const okCount = this.results.filter((r) => r.status === "ok").length;
    contentEl.createEl("h2", { text: `UTM audit: ${this.noteName}` });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `${this.results.length} UTM link${this.results.length === 1 ? "" : "s"} found · ${okCount} clean · ${this.results.length - okCount} with warnings or errors.`,
    });

    const list = contentEl.createDiv({ cls: "utm-vault-audit-list" });
    for (const item of this.results) {
      const card = list.createDiv({ cls: "utm-vault-audit-item" });
      const badge = item.status === "ok" ? "🟢" : item.status === "warn" ? "⚠️" : "🔴";
      card.createDiv({ cls: "utm-vault-audit-url", text: `${badge} ${item.url}` });
      if (!item.issues.length) {
        card.createDiv({ cls: "setting-item-description", text: "Looks good." });
      } else {
        for (const iss of item.issues) {
          card.createDiv({
            cls: iss.level === "error" ? "utm-vault-msg-error" : "utm-vault-msg-warn",
            text: `• ${iss.msg}`,
          });
        }
      }
    }

    const actions = contentEl.createDiv({ cls: "utm-vault-actions" });
    const copyBtn = actions.createEl("button", { text: "Copy audit summary", cls: "mod-cta" });
    copyBtn.addEventListener("click", async () => {
      const md = this.results
        .map((r) => {
          const icon = r.status === "ok" ? "🟢" : r.status === "warn" ? "⚠️" : "🔴";
          const notes = r.issues.length ? ` — ${r.issues.map((i) => i.msg).join("; ")}` : "";
          return `- ${icon} \`${r.url}\`${notes}`;
        })
        .join("\n");
      await navigator.clipboard.writeText(md);
      new Notice("UTM Vault: audit summary copied");
    });
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class UtmVaultSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    containerEl.empty();

    const intro = containerEl.createDiv({ cls: "setting-item-description utm-vault-intro" });
    intro.appendText("⭐ Enjoying UTM Vault? A star on ");
    intro.createEl("a", { text: "GitHub", href: "https://github.com/chi-li-peppers/obsidian-utm-vault" });
    intro.appendText(" helps other marketers find it. Found a bug or have an idea? ");
    intro.createEl("a", { text: "Open an issue", href: "https://github.com/chi-li-peppers/obsidian-utm-vault/issues" });
    intro.appendText(".");

    new Setting(containerEl)
      .setName("Default destination URL")
      .setDesc("Optional starting URL pre-filled when opening the builder.")
      .addText((t) =>
        t.setPlaceholder("https://example.com").setValue(s.defaultBaseUrl).onChange(async (v) => {
          s.defaultBaseUrl = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Force lowercase")
      .setDesc("Normalise all UTM values to lowercase so GA4 never splits Meta vs meta.")
      .addToggle((t) => t.setValue(s.lowercase).onChange(async (v) => ((s.lowercase = v), await save())));

    new Setting(containerEl)
      .setName("Word separator")
      .setDesc("Spaces inside UTM values are automatically replaced with this character.")
      .addDropdown((d) =>
        d
          .addOption("-", "Hyphen (-)")
          .addOption("_", "Underscore (_)")
          .setValue(s.separator)
          .onChange(async (v) => ((s.separator = v), await save()))
      );

    new Setting(containerEl)
      .setName("Allowed sources")
      .setDesc("Optional comma-separated list. Warn when utm_source is outside this list.")
      .addText((t) =>
        t.setPlaceholder("google, meta, linkedin, newsletter").setValue(s.allowedSources).onChange(async (v) => {
          s.allowedSources = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Allowed mediums")
      .setDesc("Optional comma-separated list. Warn when utm_medium is outside this list.")
      .addText((t) =>
        t.setPlaceholder("cpc, paid-social, email, social, video").setValue(s.allowedMediums).onChange(async (v) => {
          s.allowedMediums = v;
          await save();
        })
      );

    new Setting(containerEl).setName("Registry & Obsidian Bases").setHeading();

    new Setting(containerEl)
      .setName("Auto-save on copy or insert")
      .setDesc("Automatically record new links in your registry whenever you copy or insert them.")
      .addToggle((t) => t.setValue(s.autoSaveOnCopy).onChange(async (v) => ((s.autoSaveOnCopy = v), await save())));

    new Setting(containerEl)
      .setName("Save to Markdown registry table")
      .setDesc("Appends each tracking link as a row in a single Markdown table note.")
      .addToggle((t) =>
        t.setValue(s.saveToTable).onChange(async (v) => {
          s.saveToTable = v;
          await save();
          this.display();
        })
      );

    if (s.saveToTable) {
      new Setting(containerEl)
        .setName("Registry file path")
        .addText((t) =>
          t.setPlaceholder("UTM Registry.md").setValue(s.registryPath).onChange(async (v) => {
            s.registryPath = v || "UTM Registry.md";
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName("Create one note per link (for Obsidian Bases)")
      .setDesc("Creates a note with YAML properties (utm_source, utm_medium, utm_campaign, utm_url…) in the folder below.")
      .addToggle((t) =>
        t.setValue(s.createNotePerLink).onChange(async (v) => {
          s.createNotePerLink = v;
          await save();
          this.display();
        })
      );

    if (s.createNotePerLink) {
      new Setting(containerEl)
        .setName("UTM notes folder")
        .addText((t) =>
          t.setPlaceholder("UTM Links").setValue(s.notesFolder).onChange(async (v) => {
            s.notesFolder = v || "UTM Links";
            await save();
          })
        );
      new Setting(containerEl)
        .setName("Obsidian Base view")
        .setDesc("Generate a ready-to-use .base file listing all notes in your UTM folder.")
        .addButton((b) => b.setButtonText("Create .base file").onClick(() => this.plugin.createBaseFile()));
    }

    new Setting(containerEl).setName("Channel presets").setHeading();

    s.presets.forEach((preset, idx) => {
      const row = containerEl.createDiv({ cls: "utm-vault-preset-row" });
      new Setting(row)
        .setName(preset.name || `Preset ${idx + 1}`)
        .addText((t) =>
          t.setPlaceholder("Label").setValue(preset.name).onChange(async (v) => {
            preset.name = v;
            await save();
          })
        )
        .addText((t) =>
          t.setPlaceholder("utm_source").setValue(preset.source).onChange(async (v) => {
            preset.source = v;
            await save();
          })
        )
        .addText((t) =>
          t.setPlaceholder("utm_medium").setValue(preset.medium).onChange(async (v) => {
            preset.medium = v;
            await save();
          })
        )
        .addButton((b) =>
          b.setButtonText("Remove").onClick(async () => {
            s.presets.splice(idx, 1);
            await save();
            this.display();
          })
        );
    });

    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText("Add preset").onClick(async () => {
          s.presets.push({ name: "Custom channel", source: "", medium: "" });
          await save();
          this.display();
        })
      )
      .addButton((b) =>
        b.setButtonText("Reset defaults").onClick(async () => {
          s.presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
          await save();
          this.display();
        })
      );
  }
}

module.exports = UtmVaultPlugin;
module.exports.default = UtmVaultPlugin;
module.exports._internals = {
  normalizeUtmValue,
  parseBaseUrl,
  buildUtmUrl,
  parseUtmUrl,
  validateUtm,
  auditMarkdownLinks,
  appendToRegistryMarkdown,
  extractUrlsFromRegistry,
  buildLinkNoteContent,
  buildBaseFileContent,
  sanitizeFileName,
};
