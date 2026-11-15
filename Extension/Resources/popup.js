import { makeZip } from "./zip.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  pageTitle: "",
  pageUrl: "",
  images: [],          // [{url, width, height, el}]
  selected: new Set(), // urls
  busy: false,
  prepared: null,      // { key, files, label } waiting for a second tap to share
};

const NATIVE_BATCH = 5;
const FETCH_CONCURRENCY = 6;

// ---------- status helpers ----------
function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}
function setProgress(done, total) {
  const p = $("progress");
  if (total == null) { p.hidden = true; return; }
  p.hidden = false;
  p.max = total;
  p.value = done;
}
function setBusy(b) {
  state.busy = b;
  for (const id of ["savePhotos", "share", "zip", "rescan"]) $(id).disabled = b;
}

// ---------- scanning ----------
async function getTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scan(scroll = false) {
  setStatus(scroll ? "Scrolling page to load images…" : "Scanning…");
  const msg = { type: "scan", scroll };
  let res;
  try {
    res = await api.tabs.sendMessage(state.tab.id, msg);
  } catch {
    // Content script not injected (tab opened before install, etc.) — inject and retry.
    await api.scripting.executeScript({ target: { tabId: state.tab.id }, files: ["content.js"] });
    res = await api.tabs.sendMessage(state.tab.id, msg);
  }
  if (!res) throw new Error("No response from page. Grant this site access and reload.");
  state.pageTitle = res.title || "";
  state.pageUrl = res.url || state.tab.url || "";
  const prevSelected = state.selected;
  const known = new Map(state.images.map((i) => [i.url, i]));
  state.images = res.images.map((i) => {
    const k = known.get(i.url);
    return k ? Object.assign(k, { width: Math.max(k.width, i.width), height: Math.max(k.height, i.height) }) : i;
  });
  state.selected = new Set(
    state.images.filter((i) => prevSelected.size === 0 || prevSelected.has(i.url) || !known.has(i.url)).map((i) => i.url)
  );
  render();
  setStatus("");
}

// ---------- rendering ----------
function minSize() { return Number($("minSize").value); }

function passesFilter(img) {
  const m = minSize();
  if (!m) return true;
  if (!img.width || !img.height) return !img.loaded; // unknown yet: show until loaded
  return Math.max(img.width, img.height) >= m;
}

function visibleImages() { return state.images.filter((i) => passesFilter(i) && !i.broken); }
function chosen() { return visibleImages().filter((i) => state.selected.has(i.url)); }

function updateCount() {
  const v = visibleImages().length;
  const c = chosen().length;
  $("count").textContent = `${c} of ${v} selected`;
  $("savePhotos").textContent = c ? `Save ${c} to Photos` : "Save to Photos";
  if (state.prepared && state.prepared.key !== selectionKey(state.prepared.kind)) {
    state.prepared = null;
    $("share").textContent = "Share…";
    $("zip").textContent = "Zip";
  }
}

function render() {
  const grid = $("grid");
  grid.textContent = "";
  for (const img of state.images) {
    if (!img.el) img.el = makeTile(img);
    img.el.hidden = !passesFilter(img);
    img.el.classList.toggle("selected", state.selected.has(img.url));
    grid.appendChild(img.el);
  }
  if (!visibleImages().length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = state.images.length ? "Nothing matches the size filter." : "No images found on this page.";
    grid.appendChild(e);
  }
  updateCount();
}

function makeTile(img) {
  const b = document.createElement("button");
  b.className = "tile";
  b.type = "button";
  const im = document.createElement("img");
  im.loading = "lazy";
  im.decoding = "async";
  im.referrerPolicy = "no-referrer-when-downgrade";
  im.src = img.url;
  const check = document.createElement("span");
  check.className = "check";
  const dim = document.createElement("span");
  dim.className = "dim";
  if (img.width) dim.textContent = `${img.width}×${img.height}`;
  im.addEventListener("load", () => {
    img.loaded = true;
    if (im.naturalWidth * im.naturalHeight > img.width * img.height) {
      img.width = im.naturalWidth;
      img.height = im.naturalHeight;
    }
    dim.textContent = `${img.width}×${img.height}`;
    b.hidden = !passesFilter(img);
    updateCount();
  });
  im.addEventListener("error", () => {
    img.broken = true;
    b.classList.add("broken");
    updateCount();
  });
  b.append(im, check, dim);
  b.addEventListener("click", () => {
    if (state.selected.has(img.url)) state.selected.delete(img.url);
    else state.selected.add(img.url);
    b.classList.toggle("selected", state.selected.has(img.url));
    updateCount();
  });
  return b;
}

// ---------- fetching ----------
const MIME_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/avif": "avif", "image/heic": "heic", "image/heif": "heif", "image/bmp": "bmp",
  "image/svg+xml": "svg", "image/tiff": "tif",
};

function makeNamer() {
  const used = new Set();
  return (url, mime) => {
    let base = "image";
    try {
      const u = new URL(url);
      if (u.protocol !== "data:") {
        const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
        if (last) base = last;
      }
    } catch {}
    base = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80);
    const ext = MIME_EXT[mime] || (base.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "jpg");
    base = base.replace(/\.[a-z0-9]{2,5}$/i, "") || "image";
    let name = `${base}.${ext}`, n = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${n++}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
}

async function fetchImage(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "include", referrer: state.pageUrl });
  } catch {
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function fetchAll(images, onProgress) {
  const namer = makeNamer();
  const out = new Array(images.length);
  let done = 0, failed = 0, next = 0;
  async function worker() {
    while (next < images.length) {
      const i = next++;
      try {
        const blob = await fetchImage(images[i].url);
        const type = blob.type || "image/jpeg";
        out[i] = new File([blob], namer(images[i].url, type), { type });
      } catch {
        failed++;
      }
      onProgress(++done, images.length);
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return { files: out.filter(Boolean), failed };
}

// ---------- actions ----------
async function native(payload) {
  const r = await api.runtime.sendMessage({ type: "native", payload });
  if (!r?.ok) throw new Error(r?.error || "Native app didn't respond");
  return r.res;
}

async function saveToPhotos() {
  const list = chosen();
  if (!list.length) return setStatus("Select some images first.");
  setBusy(true);
  try {
    const status = await native({ action: "status" });
    if (status?.photos !== "authorized" && status?.photos !== "limited") {
      setStatus(
        "Photos access needed: open the SafariScraper app once and tap “Allow Photos Access”. Or use Share/Zip.",
        true
      );
      return;
    }
    let saved = 0, failed = 0;
    setProgress(0, list.length);
    for (let i = 0; i < list.length; i += NATIVE_BATCH) {
      const batch = list.slice(i, i + NATIVE_BATCH).map((x) => ({ url: x.url, referer: state.pageUrl }));
      try {
        const r = await native({ action: "save", items: batch });
        saved += r?.saved ?? 0;
        failed += r?.failed?.length ?? 0;
      } catch {
        failed += batch.length;
      }
      setProgress(Math.min(i + NATIVE_BATCH, list.length), list.length);
      setStatus(`Saving… ${saved} saved${failed ? `, ${failed} failed` : ""}`);
    }
    setStatus(`Saved ${saved} to Photos${failed ? ` · ${failed} failed (try Share or Zip for those)` : ""}.`, saved === 0);
  } catch (e) {
    setStatus(`Save failed: ${e.message}`, true);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

// navigator.share needs a fresh user tap. Fetching can take longer than Safari
// allows, so if the share is rejected we keep the files and ask for a second tap.
async function shareOrPrepare(kind, buttonId, label, build) {
  const key = selectionKey(kind);
  if (state.prepared?.key === key) {
    const files = state.prepared.files;
    try {
      await navigator.share({ files });
      setStatus("Done.");
    } catch (e) {
      if (e.name !== "AbortError") fallbackDownload(files, e);
    }
    return;
  }
  const list = chosen();
  if (!list.length) return setStatus("Select some images first.");
  setBusy(true);
  let files;
  try {
    files = await build(list);
  } catch (e) {
    setBusy(false);
    setProgress(null);
    return setStatus(e.message, true);
  }
  setBusy(false);
  setProgress(null);
  if (!files.length) return setStatus("Couldn't download any of the selected images.", true);

  if (!navigator.canShare?.({ files })) return fallbackDownload(files);
  try {
    await navigator.share({ files });
    setStatus("Done.");
  } catch (e) {
    if (e.name === "AbortError") return setStatus("");
    // Lost user activation — offer a second tap.
    state.prepared = { kind, key, files };
    $(buttonId).textContent = label;
    setStatus("Ready — tap the button again to open the share sheet.");
  }
}

function fallbackDownload(files, err) {
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  setStatus(err ? `Share failed (${err.message}); downloading instead.` : "Downloading…");
}

function selectionKey(kind) { return kind + ":" + chosen().map((i) => i.url).join("|"); }

async function buildImageFiles(list) {
  setProgress(0, list.length);
  const { files, failed } = await fetchAll(list, (d, t) => {
    setProgress(d, t);
    setStatus(`Downloading ${d}/${t}…`);
  });
  setStatus(failed ? `${failed} couldn't be downloaded.` : "");
  return files;
}

async function buildZip(list) {
  const files = await buildImageFiles(list);
  if (!files.length) return [];
  setStatus("Zipping…");
  const entries = await Promise.all(
    files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))
  );
  const host = (() => { try { return new URL(state.pageUrl).hostname; } catch { return "images"; } })();
  const name = `${(state.pageTitle || host).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "images"}.zip`;
  return [new File([makeZip(entries)], name, { type: "application/zip" })];
}

// ---------- wiring ----------
$("minSize").addEventListener("change", render);
$("selAll").addEventListener("click", () => {
  for (const i of visibleImages()) state.selected.add(i.url);
  render();
});
$("selNone").addEventListener("click", () => {
  state.selected.clear();
  render();
});
$("rescan").addEventListener("click", async () => {
  setBusy(true);
  try { await scan(true); } catch (e) { setStatus(e.message, true); }
  setBusy(false);
});
$("savePhotos").addEventListener("click", saveToPhotos);
$("share").addEventListener("click", () => {
  const n = chosen().length;
  shareOrPrepare("share", "share", `Share ${n} now`, buildImageFiles);
});
$("zip").addEventListener("click", () =>
  shareOrPrepare("zip", "zip", "Share zip now", buildZip)
);

(async () => {
  try {
    state.tab = await getTab();
    await scan(false);
  } catch (e) {
    setStatus(e.message || String(e), true);
    $("count").textContent = "Can't read this page";
  }
})();
