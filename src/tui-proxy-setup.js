import { PROXY_FIELDS, proxySetupDraft, normalizeSetupDraft } from "./proxy-setup.js";
import { STARTUP_SERVICE_IDS, normalizeStartServices } from "./startup-services.js";

const STARTUP_FIELD = { key: "startServices", group: "Startup", label: "Services started by aih start / up",
  choices: STARTUP_SERVICE_IDS, multiple: true,
  help: "Arrows move; Space toggles. Choose at least one service. Explicit CLI targets override this list. RTK is a filter; bundled pxpipe does not need its standalone service. Changes take effect on the next aih start/up." };

const clean = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Pure wizard state; all process and disk actions belong to Dashboard/manager. */
export class ProxySetupWizard {
  constructor(state) {
    this.draft = proxySetupDraft(state);
    this.currentStartServices = normalizeStartServices(state.config?.startServices);
    this.draft.startServices = this.currentStartServices.join(",");
    this.serviceIndex = 0;
    this.initial = { ...this.draft };
    this.active = state.services?.proxy?.proxyOptions;
    this.running = state.services?.proxy?.status === "running";
    this.step = 0;
    this.cursor = this.draft.upstream.length;
    this.action = 0;
    this.scroll = 0;
    this.manualScroll = false;
    this.error = "";
    this.checks = [];
    this.cancelPending = false;
    this.pasting = false;
  }

  get fields() { return [...PROXY_FIELDS.filter(f => !f.stage || this.draft.preset.split("-").includes(f.stage)), STARTUP_FIELD]; }
  get field() { return this.fields[this.step]; }
  get summary() { return this.step >= this.fields.length; }
  get dirty() { return JSON.stringify(this.initial) !== JSON.stringify(this.draft); }

  validate() {
    normalizeStartServices(this.draft.startServices.split(","));
    return normalizeSetupDraft(this.draft);
  }

  validateField() {
    const field = this.field;
    const value = this.draft[field.key];
    if (field.multiple) { normalizeStartServices(value.split(",")); return; }
    // Validate only this field, against known valid defaults, without discarding other edits.
    const base = proxySetupDraft({ services: {} });
    base.upstream = "https://example.com";
    if (field.key === "upstream") base.listen = "http://127.0.0.1:0";
    base[field.key] = value;
    normalizeSetupDraft(base);
    if (field.key === "interceptor" && value && !value.endsWith(".mjs")) throw new Error("Select a .mjs file or leave empty");
  }

  handle(key) {
    if (key === "\x1b[200~") { this.pasting = true; return; }
    if (key === "\x1b[201~") { this.pasting = false; return; }
    if (this.pasting && (this.summary || this.field?.choices || /[\x00-\x1f\x7f-\x9f]/.test(key))) return;
    if (this.cancelPending) {
      if (key === "\r" || key === "\x1b") return "cancel";
      this.cancelPending = false;
      return;
    }
    if (key === "\x1b") {
      if (!this.dirty) return "cancel";
      this.cancelPending = true;
      return;
    }
    this.error = "";
    if (key === "\x1b[5~" || key === "\x1b[6~") {
      this.scroll = Math.max(0, this.scroll + (key === "\x1b[5~" ? -4 : 4));
      this.manualScroll = true;
      return;
    }
    this.manualScroll = false;
    if (this.summary) {
      if (this.pasting) return;
      if (key === "\x1b[D" || key === "\x1b[Z") { this.step--; this.cursor = this.draft[this.field.key].length; return; }
      if (key === "\x1b[A") this.action = (this.action + 4) % 5;
      if (key === "\x1b[B" || key === "\t") this.action = (this.action + 1) % 5;
      if (key === "\r" || key === "\n") {
        if (this.action === 3) { this.step = 0; this.cursor = this.draft[this.field.key].length; return; }
        if (this.action === 4) { this.cancelPending = this.dirty; return this.dirty ? undefined : "cancel"; }
        try { this.validate(); } catch (error) { this.error = error.message; return; }
        return ["check", "save", "apply"][this.action];
      }
      return;
    }
    const f = this.field;
    const value = this.draft[f.key];
    if (key === "\x1b[Z") { this.step = Math.max(0, this.step - 1); this.cursor = this.draft[this.field.key].length; return; }
    if (!this.pasting && (key === "\r" || key === "\n" || key === "\t")) {
      try { this.validateField(); } catch (error) { this.error = error.message; return; }
      this.step++;
      if (!this.summary) this.cursor = this.draft[this.field.key].length;
      return;
    }
    if (f.choices) {
      if (f.multiple) {
        if (key === "\x1b[A") this.serviceIndex = (this.serviceIndex + f.choices.length - 1) % f.choices.length;
        if (key === "\x1b[B") this.serviceIndex = (this.serviceIndex + 1) % f.choices.length;
        if (key === " ") {
          const selected = new Set(value.split(",").filter(Boolean));
          const service = f.choices[this.serviceIndex];
          if (selected.has(service)) selected.delete(service); else selected.add(service);
          this.draft[f.key] = f.choices.filter(id => selected.has(id)).join(",");
        }
        return;
      }
      if (["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", " "].includes(key)) {
        const delta = key === "\x1b[A" || key === "\x1b[D" ? -1 : 1;
        const i = f.choices.indexOf(value);
        this.draft[f.key] = f.choices[(i + delta + f.choices.length) % f.choices.length];
        this.checks = [];
      }
      return;
    }
    const previous = this.cursor - (Array.from(value.slice(0, this.cursor)).at(-1)?.length || 0);
    const next = this.cursor + (Array.from(value.slice(this.cursor))[0]?.length || 0);
    if (key === "\x1b[D") this.cursor = previous;
    else if (key === "\x1b[C") this.cursor = next;
    else if (key === "\x01" || key === "\x1b[H" || key === "\x1b[1~") this.cursor = 0;
    else if (key === "\x05" || key === "\x1b[F" || key === "\x1b[4~") this.cursor = value.length;
    else if (key === "\x15") { this.draft[f.key] = ""; this.cursor = 0; }
    else if (key === "\x7f" || key === "\b") {
      if (this.cursor) { this.draft[f.key] = value.slice(0, previous) + value.slice(this.cursor); this.cursor = previous; }
    } else if (key === "\x1b[3~") this.draft[f.key] = value.slice(0, this.cursor) + value.slice(next);
    else if (!/[\x00-\x1f\x7f-\x9f]/.test(key)) {
      this.draft[f.key] = value.slice(0, this.cursor) + key + value.slice(this.cursor);
      this.cursor += key.length;
    }
    if (value !== this.draft[f.key]) this.checks = [];
  }

  lines(width, height, busy = false) {
    const wrap = text => {
      const lines = [];
      let line = "";
      for (const word of clean(text).split(" ")) {
        if (line && Array.from(line + " " + word).length > width) { lines.push(line); line = ""; }
        const chars = Array.from(word);
        while (chars.length > width) {
          if (line) { lines.push(line); line = ""; }
          lines.push(chars.splice(0, width).join(""));
        }
        line += (line ? " " : "") + chars.join("");
      }
      if (line || !lines.length) lines.push(line);
      return lines;
    };
    const title = `PROXY SETUP | ${this.summary ? "Summary" : `${this.field.group} (${this.step + 1}/${this.fields.length})`}`;
    let body = [];
    if (this.summary) {
      body = [...PROXY_FIELDS, STARTUP_FIELD].flatMap(f => {
        const before = f.multiple ? this.currentStartServices.join(",") : String(this.active?.[f.key] ?? "");
        const after = this.draft[f.key];
        return wrap(`${before !== after ? "* " : "  "}${f.label}: ${after || (f.key === "models" ? "pxpipe defaults; RTK/Headroom on all" : "(none)")}${before !== after ? ` (previous: ${before || "empty"})` : ""}`);
      });
      body.push(...wrap(this.running ? "WARNING: apply now restarts the proxy and interrupts active requests/streams." : "Apply now starts the proxy. Save only leaves it stopped."));
      body.push(...this.checks.flatMap(wrap));
      if (this.error) body.push(...wrap(`Error: ${this.error}`));
    } else {
      const f = this.field;
      body.push(...wrap(f.label), ...wrap(f.help), "");
      if (f.choices) body.push(...f.choices.map((v, i) => f.multiple
        ? `${i === this.serviceIndex ? ">" : " "} [${this.draft[f.key].split(",").includes(v) ? "x" : " "}] ${v}`
        : `${v === this.draft[f.key] ? ">" : " "} ${v.replaceAll("-", " -> ")}`));
      else {
        const value = this.draft[f.key];
        const start = Math.max(0, this.cursor - width + 6);
        body.push(...wrap("> " + value.slice(start, this.cursor) + "|" + value.slice(this.cursor, start + width - 4)));
      }
      body.push(...wrap(`Initial value: ${this.initial[f.key] || "(empty)"}`));
      const current = f.multiple ? this.currentStartServices.join(",") : this.active ? String(this.active[f.key] ?? "") || "(empty)" : "(not configured)";
      body.push(...wrap(`Current setting: ${current}${!f.multiple && !this.running && this.active ? " (proxy stopped)" : ""}`));
    }
    const actions = ["Check", "Save only", "Save and apply now", "Edit", "Cancel"];
    const controls = this.summary
      ? actions.map((a, i) => `${i === this.action ? ">" : " "} ${a}`)
      : wrap("Enter/Tab next | Shift+Tab back | Esc cancel").concat(wrap(this.field.multiple ? "Arrows move | Space toggle" : this.field.choices ? "Arrows/Space change" : "Ctrl+U clear | Home/End move cursor"));
    const hint = this.summary && this.action === 2
      ? this.running ? "RESTART: interrupts requests/streams." : "Apply starts the proxy."
      : this.summary ? "Arrows select | Enter confirm | Esc cancel" : "Local draft; proxy unchanged.";
    const status = this.cancelPending ? "Discard draft? Enter/Esc confirms; any other key continues" : busy ? "Operation in progress..." : this.error || hint;
    const statusLines = wrap(status);
    const tail = [...controls.flatMap(wrap), ...statusLines.slice(0, 2)];
    const budget = Math.max(1, height - 3 - tail.length);
    if (!this.summary && !this.manualScroll) {
      // Keep the chosen preset visible on short terminals.
      const selected = body.findIndex(line => line.startsWith("> "));
      this.scroll = Math.max(0, selected - budget + 1);
    }
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - budget));
    return [clean(title).slice(0, width), "-".repeat(width), ...body.slice(this.scroll, this.scroll + budget),
      ...(body.length > budget ? ["PgUp/PgDn: scroll details"] : [""]), ...tail].slice(0, height);
  }
}
