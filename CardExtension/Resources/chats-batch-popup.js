// Batch chat export UI: find chats → pick → run → review → save zip of .jsonl.
import { sendToPage } from "./page.js";
import { buildJsonl, debugFile } from "./chat.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById(id);
const send = sendToPage;
const C = { index: [], pick: new Set(), results: [], keep: new Set(), poll: null, prepared: null, busy: false };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

export async function probeChats() {
  try { return await send({ type: "chatsProbe" }); } catch (e) { return { error: e.message || String(e) }; }
}

function show(panel) {
  for (const id of ["cbIdle", "cbPick", "cbRunning", "cbResults"]) $(id).hidden = id !== panel;
  $("chatBatchActions").hidden = !(panel === "cbResults" || panel === "cbPick");
  $("cbSave").hidden = panel !== "cbResults";
  $("cbStart").hidden = panel !== "cbPick";
}

const fmt = (n) => (n == null ? "?" : n.toLocaleString());
const safe = (s) => (s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 60) || "chat";

export async function refreshChats(probe) {
  const s = probe || (await probeChats());
  clearInterval(C.poll);
  if (s.status === "running") {
    show("cbRunning");
    $("cbProgress").max = s.total || 1;
    $("cbProgress").value = s.pos;
    $("cbRunText").textContent = `Exporting ${Math.min(s.pos + 1, s.total)}/${s.total}${s.current ? " · " + s.current : ""}`;
    setStatus("Keep Safari open with the screen on. You can close this popup.");
    C.poll = setInterval(() => refreshChats(), 1500);
    return;
  }
  const st = await send({ type: "chatsState" });
  if ((s.status === "done" || s.status === "stopped") && st?.results?.length) return renderResults(st, s);
  if (st?.index?.length) return renderPick(st);
  show("cbIdle");
  $("cbFind").disabled = s.page !== "chatslist";
  $("cbDebug").hidden = !(s.myChats && s.page !== "chatslist");
  $("cbIdleText").textContent = s.page === "chatslist"
    ? `Found ${s.rows} characters. “Find all chats” opens each one's list of chats (nothing is opened yet).`
    : s.myChats
      ? `This is My Chats, but I can't make out the character rows (found ${s.countLabels} “chats:” labels). Scroll down to “All characters” and reopen CardScraper. If it still says this, tap Debug file and send it to Claude.`
      : "Open JanitorAI's “My Chats” page, then come back here.";
}

function renderPick(st) {
  C.index = st.index;
  const info = st.indexInfo || {};
  const notes = [];
  if (info.expected && C.index.length < info.expected) notes.push(`My Chats says ${info.expected} chats; found ${C.index.length}.`);
  for (const sh of info.short || []) notes.push(sh);
  $("cbIndexNote").hidden = !notes.length;
  $("cbIndexNote").textContent = notes.length ? "⚠ " + notes.join(" · ") + " Try “Start over” → “Find all chats” again, or send Claude a Debug file." : "";
  if (!C.pick.size) C.pick = new Set(C.index.map((c) => c.id));
  show("cbPick");
  const list = $("cbPickList");
  list.textContent = "";
  const byChar = new Map();
  for (const c of C.index) (byChar.get(c.char) || byChar.set(c.char, []).get(c.char)).push(c);
  for (const [char, chats] of byChar) {
    const head = document.createElement("li");
    head.className = "cb-head";
    const all = document.createElement("input");
    all.type = "checkbox";
    all.checked = chats.every((c) => C.pick.has(c.id));
    all.addEventListener("change", () => { chats.forEach((c) => (all.checked ? C.pick.add(c.id) : C.pick.delete(c.id))); renderPick(st); });
    const lbl = document.createElement("label");
    lbl.append(all, document.createTextNode(` ${char} · ${chats.length} chat${chats.length > 1 ? "s" : ""}`));
    head.append(lbl);
    list.append(head);
    for (const c of chats) {
      const li = document.createElement("li");
      li.className = "cb-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = C.pick.has(c.id);
      cb.addEventListener("change", () => { cb.checked ? C.pick.add(c.id) : C.pick.delete(c.id); updatePickCount(); });
      const info = document.createElement("span");
      info.innerHTML = "";
      const t = document.createElement("b");
      t.textContent = `${c.date} · as ${c.personas.join(", ")} · ${fmt(c.count)} msgs`;
      const p = document.createElement("span");
      p.className = "bsub";
      p.textContent = c.preview;
      info.append(t, document.createElement("br"), p);
      const label = document.createElement("label");
      label.append(cb, info);
      li.append(label);
      list.append(li);
    }
  }
  updatePickCount();
}

function updatePickCount() {
  const chosen = C.index.filter((c) => C.pick.has(c.id));
  const msgs = chosen.reduce((n, c) => n + (c.count || 0), 0);
  $("cbPickSummary").textContent = `${chosen.length} of ${C.index.length} chats selected · ~${fmt(msgs)} messages`;
  $("cbStart").textContent = `Export ${chosen.length} chat${chosen.length === 1 ? "" : "s"}`;
  $("cbStart").disabled = !chosen.length;
}

function renderResults(st, s) {
  C.results = st.results;
  if (!C.keep.size) C.keep = new Set(C.results.filter((r) => r.got > 0).map((r) => r.id));
  show("cbResults");
  const remaining = (st.queue?.length || 0) - (st.pos || 0);
  $("cbResume").hidden = !(s.status === "stopped" && remaining > 0);
  $("cbResume").textContent = `Resume (${remaining} left)`;
  const failed = C.results.filter((r) => r.errors.length).length;
  $("cbRetry").hidden = !failed;
  $("cbRetry").textContent = `Retry ${failed} with problems`;
  const list = $("cbResultList");
  list.textContent = "";
  for (const r of C.results) {
    const li = document.createElement("li");
    li.className = "bres" + (r.errors.length ? " warn" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = C.keep.has(r.id);
    cb.addEventListener("change", () => { cb.checked ? C.keep.add(r.id) : C.keep.delete(r.id); C.prepared = null; updateResultCount(); });
    const info = document.createElement("div");
    info.className = "binfo";
    const t = document.createElement("div");
    t.className = "btitle";
    t.textContent = `${r.char} · ${r.date}`;
    const sub = document.createElement("div");
    sub.className = "bsub";
    sub.textContent = `as ${r.personas.join(", ")} · ${fmt(r.got)}${r.count ? " of " + fmt(r.count) : ""} messages`;
    info.append(t, sub);
    for (const e of r.errors) {
      const d = document.createElement("div");
      d.className = "berr";
      d.textContent = "⚠ " + e;
      info.append(d);
    }
    const label = document.createElement("label");
    label.append(cb, info);
    li.append(label);
    list.append(li);
  }
  updateResultCount();
}

function updateResultCount() {
  const n = C.keep.size;
  const bad = C.results.filter((r) => r.errors.length).length;
  $("cbResultSummary").textContent = `${C.results.length} exported · ${bad} with problems · ${n} selected`;
  $("cbSave").textContent = `Save ${n} chat${n === 1 ? "" : "s"} (.zip)`;
  $("cbSave").disabled = !n || C.busy;
}

async function buildZip() {
  const chosen = C.results.filter((r) => C.keep.has(r.id));
  const used = new Set();
  const entries = [];
  const md = $("cbMarkdown").checked;
  let k = 0;
  for (const r of chosen) {
    setStatus(`Packing ${++k}/${chosen.length} · ${r.char}`);
    const rec = await send({ type: "chatsGet", id: r.id });
    if (!rec) continue;
    const jsonl = buildJsonl({
      charName: rec.charName,
      userName: rec.userName,
      messages: rec.messages.map((m) => ({
        is_user: !!m.is_user,
        name: m.speaker || (m.is_user ? rec.userName : rec.charName),
        text: md ? m.md : m.plain,
      })),
    });
    let name = `${safe(r.char)}/${safe(r.date)} - as ${safe(r.personas.join(", "))} (${r.got} msgs).jsonl`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = name.replace(/( \(\d+\))?\.jsonl$/, ` (${n++}).jsonl`);
    used.add(name.toLowerCase());
    entries.push({ name, data: new TextEncoder().encode(jsonl) });
  }
  return new File([makeZip(entries)], `JanitorAI chats (${entries.length}).zip`, { type: "application/zip" });
}

async function deliver() {
  try {
    let file = C.prepared;
    if (!file) {
      C.busy = true;
      updateResultCount();
      file = await buildZip();
      C.busy = false;
      updateResultCount();
    }
    if (!navigator.canShare?.({ files: [file] })) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      setStatus(`Downloaded ${file.name}`);
      return;
    }
    try {
      await navigator.share({ files: [file] });
      C.prepared = null;
      setStatus("Saved.");
    } catch (e) {
      if (e.name === "AbortError") return setStatus("");
      C.prepared = file;
      $("cbSave").textContent = "Tap to save";
      setStatus("Ready. Tap again to open the share sheet (choose Save to Files).");
    }
  } catch (e) {
    C.busy = false;
    updateResultCount();
    setStatus(e.message || String(e), true);
  }
}

export function initChatsBatch() {
  $("cbDebug").addEventListener("click", async () => {
    try {
      const f = await debugFile();
      if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f] });
      else { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); }
    } catch (e) { if (e.name !== "AbortError") setStatus(e.message || String(e), true); }
  });
  $("cbFind").addEventListener("click", async () => {
    $("cbFind").disabled = true;
    setStatus("Opening each character's chat list… (nothing is changed)");
    const r = await send({ type: "chatsIndex" });
    if (!r?.ok) { setStatus(r?.error || "Couldn't list the chats.", true); $("cbFind").disabled = false; return; }
    const miss = r.expected && r.chats.length < r.expected;
    setStatus(`Found ${r.chats.length}${r.expected ? " of " + r.expected : ""} chats from ${r.characters} characters.` +
      (miss ? " Some are missing, see the note above the list." : ""), !!miss);
    C.pick = new Set();
    refreshChats();
  });
  $("cbAll").addEventListener("click", () => { C.pick = new Set(C.index.map((c) => c.id)); refreshChats(); });
  $("cbNone").addEventListener("click", () => { C.pick.clear(); refreshChats(); });
  $("cbStart").addEventListener("click", async () => {
    const r = await send({ type: "chatsStart", ids: [...C.pick] });
    if (!r?.ok) return setStatus(r?.error || "Couldn't start.", true);
    C.keep = new Set();
    refreshChats();
  });
  $("cbStop").addEventListener("click", async () => { await send({ type: "chatsStop" }); refreshChats(); });
  $("cbResume").addEventListener("click", async () => { await send({ type: "chatsResume" }); refreshChats(); });
  $("cbRetry").addEventListener("click", async () => {
    const ids = C.results.filter((r) => r.errors.length).map((r) => r.id);
    await send({ type: "chatsStart", ids, keepResults: true });
    refreshChats();
  });
  $("cbReindex").addEventListener("click", async () => {
    if (!confirm("Start over? This clears the chat list and any exported chats not yet saved.")) return;
    await send({ type: "chatsClear" });
    C.pick.clear(); C.keep.clear(); C.results = []; C.index = [];
    refreshChats();
  });
  $("cbSave").addEventListener("click", deliver);
  $("cbMarkdown").addEventListener("change", () => { C.prepared = null; });
}
