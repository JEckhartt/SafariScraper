import { sendToPage } from "./page.js";
// Batch tab: start/stop the in-page batch run, then review results
// (deselect, see problems) and save cards as PNGs or one zip.
import { buildCard, embedCard, isPng } from "./png.js";
import { makeZip } from "./zip.js";
import { probeChats, refreshChats, initChatsBatch } from "./chats-batch-popup.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const B = { results: [], selected: new Set(), poll: null, prepared: null, busy: false };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

const send = sendToPage;

export async function probeBatch() {
  try { return await send({ type: "batchProbe" }); } catch (e) { return { error: e.message || String(e) }; }
}

function show(stateName) {
  for (const id of ["batchIdle", "batchRunning", "batchResults"]) $(id).hidden = id !== stateName;
  $("batchActions").hidden = stateName !== "batchResults";
}

// Character batch or chat batch, whichever this page / run is about.
export async function refreshBatch() {
  const [s0, c] = await Promise.all([probeBatch(), probeChats()]);
  const chatsMode = c && !c.error && !s0?.status && (c.status || c.indexed || c.page === "chatslist");
  $("charBatch").hidden = !!chatsMode;
  $("chatBatch").hidden = !chatsMode;
  if (chatsMode) {
    $("batchActions").hidden = true;
    return refreshChats(c);
  }
  $("chatBatchActions").hidden = true;
  return refreshCharBatch(s0);
}

async function refreshCharBatch(s0) {
  const s = s0 ?? (await probeBatch());
  if (!s || s.error) {
    show("batchIdle");
    $("batchIdleText").textContent = "";
    $("batchStart").disabled = true;
    setStatus(s?.error || "Couldn't reach the page.", true);
    return;
  }
  clearInterval(B.poll);
  if (s.status === "running") {
    show("batchRunning");
    $("batchProgress").max = s.total || 1;
    $("batchProgress").value = s.pos;
    $("batchRunText").textContent = `Scraping ${Math.min(s.pos + 1, s.total)}/${s.total}${s.current ? " · " + s.current : ""}`;
    setStatus("You can close this. The page keeps going; reopen CardScraper when it says Done.");
    B.poll = setInterval(() => refreshCharBatch(), 1200);
    return;
  }
  if (s.status === "done" || s.status === "stopped") {
    await loadResults(s);
    return;
  }
  show("batchIdle");
  const onList = s.page === "list";
  $("batchStart").disabled = !onList;
  $("batchIdleText").textContent = onList
    ? `Found ${s.cardsVisible}${s.expected ? " of " + s.expected : ""} characters on this page. Scraping opens each one's Edit page, reads it, and comes back.`
    : "Open your “My Characters” page (the one with an Edit button on each character), then come back here.";
}

async function loadResults(summary) {
  const st = await send({ type: "batchResults" });
  B.results = (st?.results || []).map((r, i) => ({ ...r, _i: i }));
  if (!B.selected.size || B.selected.size > B.results.length) {
    B.selected = new Set(B.results.filter((r) => r.title || r.personality || r.first_mes).map((r) => r._i));
  }
  show("batchResults");
  const remaining = (st?.queue?.length || 0) - (st?.pos || 0);
  $("batchResume").hidden = !(summary.status === "stopped" && remaining > 0);
  $("batchResume").textContent = `Resume (${remaining} left)`;
  const failed = B.results.filter((r) => problems(r).length).length;
  $("batchRetry").hidden = !failed || summary.status === "stopped" && remaining > 0;
  $("batchRetry").textContent = `Retry ${failed} with problems`;
  renderResults();
}

function problems(r) { return r.errors || []; }

function renderResults() {
  const list = $("batchList");
  list.textContent = "";
  for (const r of B.results) {
    const li = document.createElement("li");
    li.className = "bres" + (problems(r).length ? " warn" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = B.selected.has(r._i);
    cb.addEventListener("change", () => {
      cb.checked ? B.selected.add(r._i) : B.selected.delete(r._i);
      B.prepared = null;
      updateCounts();
    });
    const img = document.createElement("img");
    img.src = r.image || r.thumb || "";
    img.alt = "";
    img.loading = "lazy";
    const info = document.createElement("div");
    info.className = "binfo";
    const t = document.createElement("div");
    t.className = "btitle";
    t.textContent = r.title || r.name || "(no title)";
    const sub = document.createElement("div");
    sub.className = "bsub";
    const bits = [];
    if (r.chatName && r.chatName !== r.title) bits.push(`chat name: ${r.chatName}`);
    if (r.personality) bits.push(`${r.personality.length.toLocaleString()} chars personality`);
    if (r.alternate_greetings?.length) bits.push(`+${r.alternate_greetings.length} alt greetings`);
    sub.textContent = bits.join(" · ");
    info.append(t, sub);
    for (const p of problems(r)) {
      const e = document.createElement("div");
      e.className = "berr";
      e.textContent = "⚠ " + p;
      info.append(e);
    }
    const label = document.createElement("label");
    label.append(cb, img, info);
    li.append(label);
    list.append(li);
  }
  updateCounts();
}

function updateCounts() {
  const n = B.selected.size;
  const bad = B.results.filter((r) => problems(r).length).length;
  $("batchSummary").textContent = `${B.results.length} scraped · ${bad} with problems · ${n} selected`;
  $("batchSave").textContent = `Save ${n} card${n === 1 ? "" : "s"}`;
  $("batchSave").disabled = $("batchZip").disabled = !n || B.busy;
}

// ---------- building cards ----------
async function fetchImageBytes(url, referrer) {
  let res;
  try { res = await fetch(url, { credentials: "include", referrer }); } catch { res = await fetch(url); }
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  return res.blob();
}

async function toPngBytes(blob) {
  const raw = new Uint8Array(await blob.arrayBuffer());
  if (isPng(raw)) return raw;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
  if (!png) throw new Error("couldn't convert image");
  return new Uint8Array(await png.arrayBuffer());
}

const BLANK_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));

function cardFor(r) {
  const asDesc = $("batchPersAsDesc").checked;
  const title = r.title || r.name || "Character";
  return buildCard({
    name: title,
    nickname: r.chatName && r.chatName !== title ? r.chatName : undefined,
    description: asDesc ? r.personality : "",
    personality: asDesc ? "" : r.personality,
    scenario: r.scenario,
    first_mes: r.first_mes,
    alternate_greetings: r.alternate_greetings,
    mes_example: r.mes_example,
    creator_notes: r.bio,
    source: r.url,
    extra: { janitor: { title, chat_name: r.chatName || "" } },
  });
}

async function buildFiles() {
  const chosen = B.results.filter((r) => B.selected.has(r._i));
  const used = new Set();
  const files = [];
  const failed = [];
  let k = 0;
  for (const r of chosen) {
    setStatus(`Building ${++k}/${chosen.length} · ${r.title || r.name}`);
    let bytes = BLANK_PNG;
    const src = r.image || r.thumb;
    if (src) {
      try { bytes = await toPngBytes(await fetchImageBytes(src, r.url)); }
      catch (e) { failed.push(`${r.title || r.name}: ${e.message} (saved without image)`); }
    }
    const out = embedCard(bytes, cardFor(r));
    let base = (r.title || r.name || "character").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80);
    let name = `${base}.png`, n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).png`;
    used.add(name.toLowerCase());
    files.push(new File([out], name, { type: "image/png" }));
  }
  return { files, failed };
}

function download(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function deliver(kind, buttonId, makeFiles) {
  try {
    let files, note = "";
    if (B.prepared?.kind === kind) {
      files = B.prepared.files;
    } else {
      B.busy = true;
      updateCounts();
      const r = await makeFiles();
      files = r.files;
      if (r.failed.length) note = ` ${r.failed.length} without image: ${r.failed.join("; ")}`;
      B.busy = false;
      updateCounts();
    }
    if (!navigator.canShare?.({ files })) {
      files.forEach(download);
      setStatus(`Downloaded ${files.length} file${files.length > 1 ? "s" : ""}.${note}`);
      return;
    }
    try {
      await navigator.share({ files });
      setStatus(`Saved.${note}`);
      B.prepared = null;
      $(buttonId).textContent = buttonId === "batchZip" ? "Zip" : $("batchSave").textContent;
      updateCounts();
    } catch (e) {
      if (e.name === "AbortError") return setStatus("");
      B.prepared = { kind, files };
      $(buttonId).textContent = "Tap to save";
      setStatus(`Ready. Tap again to open the share sheet (choose Save to Files).${note}`);
    }
  } catch (e) {
    B.busy = false;
    updateCounts();
    setStatus(e.message || String(e), true);
  }
}

export function initBatch() {
  initChatsBatch();
  $("batchStart").addEventListener("click", async () => {
    $("batchStart").disabled = true;
    setStatus("Loading the whole list…");
    const r = await send({ type: "batchStart" });
    if (!r?.ok) {
      setStatus(r?.error || "Couldn't start.", true);
      $("batchStart").disabled = false;
      return;
    }
    B.selected = new Set();
    refreshBatch();
  });
  $("batchStop").addEventListener("click", async () => { await send({ type: "batchStop" }); refreshBatch(); });
  $("batchResume").addEventListener("click", async () => { await send({ type: "batchResume" }); refreshBatch(); });
  $("batchRetry").addEventListener("click", async () => {
    const indices = B.results.filter((r) => problems(r).length).map((r) => r._i);
    await send({ type: "batchRetry", indices });
    refreshBatch();
  });
  $("batchClear").addEventListener("click", async () => {
    if (!confirm("Clear these results? (They're not saved anywhere else.)")) return;
    await send({ type: "batchClear" });
    B.results = [];
    B.selected.clear();
    refreshBatch();
  });
  $("batchAll").addEventListener("click", () => { B.selected = new Set(B.results.map((r) => r._i)); B.prepared = null; renderResults(); });
  $("batchNone").addEventListener("click", () => { B.selected.clear(); B.prepared = null; renderResults(); });
  $("batchPersAsDesc").addEventListener("change", () => { B.prepared = null; });
  $("batchSave").addEventListener("click", () => deliver("png", "batchSave", buildFiles));
  $("batchZip").addEventListener("click", () => deliver("zip", "batchZip", async () => {
    const { files, failed } = await buildFiles();
    setStatus("Zipping…");
    const entries = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    return { files: [new File([makeZip(entries)], `Characters (${files.length}).zip`, { type: "application/zip" })], failed };
  }));
}
