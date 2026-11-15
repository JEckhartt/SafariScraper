import { buildCard, embedCard, isPng } from "./png.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FIELD_IDS = ["scenario", "personality", "first_mes", "mes_example"];

const state = { tab: null, url: "", images: [], imageIndex: 0, prepared: null };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function updateCounts() {
  for (const el of document.querySelectorAll(".count")) {
    const n = $(el.dataset.for).value.trim().length;
    el.textContent = n ? `· ${n.toLocaleString()} chars` : "· not found";
    el.classList.toggle("empty", !n);
  }
}

function invalidate() {
  state.prepared = null;
  $("savePng").textContent = "Save card PNG";
  $("saveJson").textContent = "JSON";
}

function selectImage(i) {
  state.imageIndex = i;
  const img = state.images[i];
  $("preview").src = img?.url || "";
  $("imgInfo").textContent = img
    ? (img.width ? `${img.width}×${img.height}` : "size unknown") + (state.images.length > 1 ? " · tap below to pick another" : "")
    : "No image found";
  [...$("thumbs").children].forEach((b, j) => b.classList.toggle("on", j === i));
  invalidate();
}

function renderThumbs() {
  const box = $("thumbs");
  box.textContent = "";
  if (state.images.length < 2) return;
  state.images.forEach((img, i) => {
    const b = document.createElement("button");
    b.type = "button";
    const im = document.createElement("img");
    im.src = img.url;
    im.loading = "lazy";
    b.append(im);
    b.addEventListener("click", () => selectImage(i));
    box.append(b);
  });
}

async function scrape() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  let res;
  try {
    res = await api.tabs.sendMessage(tab.id, { type: "card" });
  } catch {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    res = await api.tabs.sendMessage(tab.id, { type: "card" });
  }
  if (!res) throw new Error("No response from page. Allow CardScraper on this site and reload.");

  state.url = res.url;
  state.images = res.images || [];
  $("name").value = res.name || "";
  for (const id of FIELD_IDS) $(id).value = res.fields?.[id] || "";
  renderThumbs();
  selectImage(0);
  updateCounts();

  const missing = FIELD_IDS.filter((id) => !res.fields?.[id]);
  if (missing.length === FIELD_IDS.length) {
    setStatus("Couldn't find the text sections. Expand them on the page (or paste them in) and reopen.", true);
  } else if (missing.length) {
    setStatus(`Missing: ${missing.map((m) => document.querySelector(`label[for=${m}]`).firstChild.textContent.trim()).join(", ")}. You can type or paste them in.`);
  } else {
    setStatus("All four sections found. Check them over, then save.");
  }
}

function currentCard() {
  const personality = $("personality").value.trim();
  const asDesc = $("persAsDesc").checked;
  return buildCard({
    name: $("name").value.trim(),
    description: asDesc ? personality : "",
    personality: asDesc ? "" : personality,
    scenario: $("scenario").value.trim(),
    first_mes: $("first_mes").value.trim(),
    mes_example: $("mes_example").value.trim(),
    source: state.url,
  });
}

function safeName() {
  return ($("name").value.trim() || "character").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80);
}

async function fetchImageBytes(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "include", referrer: state.url });
  } catch {
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);
  return res.blob();
}

// Any format -> PNG bytes (keeps the original bytes if it's already a PNG).
async function toPngBytes(blob) {
  const raw = new Uint8Array(await blob.arrayBuffer());
  if (isPng(raw)) return raw;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
  if (!png) throw new Error("Couldn't convert image to PNG");
  return new Uint8Array(await png.arrayBuffer());
}

// 1×1 transparent PNG, used when the page has no usable image.
const BLANK_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));

async function buildPngFile() {
  const img = state.images[state.imageIndex];
  let bytes = BLANK_PNG;
  if (img) {
    setStatus("Downloading image…");
    bytes = await toPngBytes(await fetchImageBytes(img.url));
  }
  setStatus("Embedding text…");
  const out = embedCard(bytes, currentCard());
  return new File([out], `${safeName()}.png`, { type: "image/png" });
}

function buildJsonFile() {
  return new File([JSON.stringify(currentCard(), null, 2)], `${safeName()}.json`, { type: "application/json" });
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

// Share sheet needs a fresh tap; if building took too long, keep the file and ask for a second tap.
async function deliver(kind, buttonId, build) {
  const btns = [$("savePng"), $("saveJson")];
  try {
    let file;
    if (state.prepared?.kind === kind) {
      file = state.prepared.file;
    } else {
      btns.forEach((b) => (b.disabled = true));
      file = await build();
      btns.forEach((b) => (b.disabled = false));
    }
    if (!navigator.canShare?.({ files: [file] })) {
      download(file);
      setStatus(`Downloaded ${file.name}`);
      return;
    }
    try {
      await navigator.share({ files: [file] });
      setStatus(`Saved ${file.name}`);
      invalidate();
    } catch (e) {
      if (e.name === "AbortError") return setStatus("");
      state.prepared = { kind, file };
      $(buttonId).textContent = "Tap to save";
      setStatus("Ready. Tap the button again to open the share sheet (choose Save to Files).");
    }
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    setStatus(e.message || String(e), true);
  }
}

$("savePng").addEventListener("click", () => deliver("png", "savePng", buildPngFile));
$("saveJson").addEventListener("click", () => deliver("json", "saveJson", async () => buildJsonFile()));
for (const id of [...FIELD_IDS, "name"]) {
  $(id).addEventListener("input", () => { invalidate(); updateCounts(); });
}
$("persAsDesc").addEventListener("change", invalidate);

scrape().catch((e) => setStatus(e.message || String(e), true));
