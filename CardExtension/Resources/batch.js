// CardScraper batch mode: walk a "My Characters" list, open each character's
// Edit page, read General + Definition, go back, repeat.
//
// Read-only by design: it only clicks "Edit", the "General"/"Definition" tabs,
// the initial-message chips (to read alternates) and the browser's Back. It never
// clicks Delete or Update, and never types into a field.
//
// State lives in sessionStorage so the run survives page loads; it works the
// same whether the site navigates with real page loads or client-side routing.
(() => {
  if (window.__cardScraperBatchLoaded) return;
  window.__cardScraperBatchLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const lib = () => globalThis.__cardScraperLib;
  const KEY = "cardscraper-batch";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // ---------- state ----------
  function load() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; }
  }
  function save(st) {
    try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { console.warn("CardScraper: state not saved", e); }
  }

  async function waitFor(fn, timeout = 15000, interval = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(interval);
    }
    return null;
  }

  const visible = (el) => !!el && el.getClientRects().length > 0;

  // ---------- generic page helpers ----------
  function clickables() {
    return [...document.querySelectorAll("button, a, [role=button], [role=tab]")].filter(visible);
  }
  const DANGER = /delete|remove|update|save|publish|discard|trash/i;
  function findClickable(text) {
    const want = text.toLowerCase();
    return clickables().find((el) => clean(el.textContent).toLowerCase() === want &&
      !DANGER.test(el.getAttribute("aria-label") || ""));
  }
  function tabButton(text) {
    // A real tab/button, not the "Definition" heading further down the page.
    return clickables().find((el) => clean(el.textContent).toLowerCase() === text.toLowerCase());
  }

  // Label element by its visible text: "Title *", "Initial messages (first messages) * (1/10)", …
  function findLabel(text) {
    const re = new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    let best = null;
    for (const el of document.body.querySelectorAll("label, div, span, p, h1, h2, h3, h4, h5, h6, legend, dt")) {
      if (!visible(el)) continue;
      const t = clean(el.textContent);
      if (t.length > 70 || !re.test(t)) continue;
      // deepest match
      if (![...el.children].some((c) => re.test(clean(c.textContent)) && clean(c.textContent).length <= 70)) { best = el; break; }
    }
    return best;
  }

  const FIELD_SEL = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=search]), textarea, [contenteditable=true], [contenteditable='']";

  function fieldAfter(label) {
    if (!label) return null;
    for (const f of document.querySelectorAll(FIELD_SEL)) {
      if (label.contains(f)) continue;
      if (label.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) return f;
    }
    return null;
  }

  function valueOf(f) {
    if (!f) return "";
    if (f.matches("input, textarea")) return f.value || "";
    return lib().toMarkdown([...f.childNodes]); // rich text editor
  }

  const field = (label) => fieldAfter(findLabel(label));

  // ---------- list page ----------
  function editButtons() {
    return clickables().filter((el) => /^edit$/i.test(clean(el.textContent)) && !el.closest("nav, header"));
  }

  function cardOf(btn) {
    let card = btn;
    while (card.parentElement && card.parentElement !== document.body) {
      const p = card.parentElement;
      if (p.querySelectorAll("*").length > 400) break;
      const n = [...p.querySelectorAll("button, a, [role=button]")].filter((b) => /^edit$/i.test(clean(b.textContent))).length;
      if (n > 1) break;
      card = p;
    }
    return card;
  }

  const SKIP_TEXT = /^(edit|limitless|limited|private|public|\d[\d.,]*\s*k?\s*(tokens?)?|hidden tokens|\d+)$/i;
  function cardName(card) {
    for (const el of card.querySelectorAll("*")) {
      if ([...el.children].some((c) => clean(c.textContent))) continue;
      const t = clean(el.textContent);
      if (!t || SKIP_TEXT.test(t) || /tokens?$/i.test(t) || !/\p{L}/u.test(t)) continue; // icons/emoji (🔒) aren't names
      if (t.length <= 80) return t;
    }
    return "";
  }

  function cardImage(card) {
    let best = null, area = 0;
    for (const img of card.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = img.currentSrc || img.src; }
    }
    return best;
  }

  function listCards() {
    return editButtons().map((btn, i) => {
      const card = cardOf(btn);
      const link = btn.closest("a")?.href || card.querySelector("a[href]")?.href || null;
      return { i, name: cardName(card), href: link, thumb: cardImage(card), btn };
    });
  }

  function expectedTotal() {
    for (const el of document.querySelectorAll("h1, h2, h3, span, div, p")) {
      const m = clean(el.textContent).match(/^\((\d+)\)$/);
      if (m && visible(el)) return +m[1];
    }
    return null;
  }

  function isEditPage() { return !!(tabButton("General") && tabButton("Definition")); }
  function isListPage() { return !isEditPage() && editButtons().length > 0; }

  function scroller() {
    let best = document.scrollingElement || document.documentElement, h = best.scrollHeight;
    for (const el of document.querySelectorAll("main, div")) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 50 && el.scrollHeight > h * 0.8 && el.clientHeight > innerHeight * 0.5) {
        best = el; h = el.scrollHeight;
      }
    }
    return best;
  }

  // Scroll until every card has loaded (infinite lists).
  async function loadWholeList(status) {
    const want = expectedTotal();
    let stable = 0, last = -1;
    for (let i = 0; i < 80 && stable < 4; i++) {
      const n = editButtons().length;
      status?.(`Loading list… ${n}${want ? "/" + want : ""}`);
      if (want && n >= want) break;
      const sc = scroller();
      sc.scrollTop = sc.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(700);
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
    const sc = scroller();
    sc.scrollTop = 0;
    window.scrollTo(0, 0);
    return listCards();
  }

  async function findCardFor(target) {
    for (let tries = 0; tries < 40; tries++) {
      const cards = listCards();
      if (target.href) {
        const byHref = cards.find((c) => c.href === target.href);
        if (byHref) return byHref;
      } else {
        const byIdx = cards[target.i];
        if (byIdx && byIdx.name === target.name) return byIdx;
      }
      // Not loaded yet: scroll further.
      const before = cards.length;
      const sc = scroller();
      sc.scrollTop = sc.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(600);
      if (tries > 6 && listCards().length === before) break; // list fully loaded
    }
    // Last resort: a name that appears exactly once.
    const cards = listCards();
    const same = cards.filter((c) => target.name && c.name === target.name);
    return same.length === 1 ? same[0] : null;
  }

  // ---------- edit page ----------
  function imageUnder(labelText) {
    const label = findLabel(labelText);
    if (!label) return null;
    let best = null, area = 0;
    for (const img of document.querySelectorAll("img")) {
      if (!(label.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 60) continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = img.currentSrc || img.src; }
      if (best) break; // first big image after "Image" is the avatar preview
    }
    return best;
  }

  // Alternate initial messages: chips above the Write box. Click each one
  // (read-only) and read the Write box; verify the text matches the chip.
  async function readGreetings() {
    const label = findLabel("Initial messages");
    const box = fieldAfter(label);
    if (!box) return { first: "", alternates: [] };
    const first = valueOf(box);
    const chips = clickables().filter((el) => {
      if (!(label.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      if (!(el.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)) return false; // must be before the box
      const t = clean(el.textContent);
      if (!t || t === "+" || /^(write|preview)$/i.test(t)) return false;
      if (DANGER.test((el.getAttribute("aria-label") || "") + " " + t)) return false;
      return true;
    });
    if (chips.length < 2) return { first, alternates: [] };
    const texts = [];
    for (const chip of chips) {
      const want = clean(chip.textContent).replace(/[.…]+$/, "").slice(0, 20).toLowerCase();
      chip.click();
      const got = await waitFor(() => {
        const b = fieldAfter(findLabel("Initial messages"));
        const v = valueOf(b);
        return clean(v).toLowerCase().startsWith(want) ? v : null;
      }, 3000);
      if (got && !texts.includes(got)) texts.push(got);
    }
    chips[0].click(); // leave it as we found it
    const firstMsg = texts[0] || first;
    return { first: firstMsg, alternates: texts.filter((t) => t !== firstMsg) };
  }

  async function scrapeEditPage(target) {
    const errors = [];
    const rec = { i: target.i, name: target.name, href: target.href, thumb: target.thumb, url: location.href, errors };

    const general = tabButton("General");
    if (general) { general.click(); await sleep(300); }

    // Wait for the form to fill (data loads after the page appears).
    const titleField = await waitFor(() => field("Title"), 25000);
    if (!titleField) errors.push("Title field not found");
    await waitFor(() => valueOf(field("Title")).trim(), 20000);

    rec.title = valueOf(field("Title")).trim();
    rec.chatName = valueOf(field("Chat name")).trim();
    rec.bio = lib().tidy(valueOf(field("Bio")));
    rec.image = imageUnder("Image") || target.thumb || null;
    if (!rec.title) errors.push("Title empty");
    if (!rec.image) errors.push("No image");
    if (target.name && rec.title && rec.title !== target.name) errors.push(`Opened “${rec.title}”, expected “${target.name}”`);

    const def = await waitFor(() => tabButton("Definition"), 5000);
    if (!def) {
      errors.push("Definition tab not found");
      return rec;
    }
    def.click();
    const pers = await waitFor(() => field("Personality"), 20000);
    if (!pers) errors.push("Personality field not found");
    await waitFor(() => valueOf(field("Personality")).trim(), 3000);

    rec.personality = valueOf(field("Personality")).trim();
    rec.scenario = valueOf(field("Scenario")).trim();
    const g = await readGreetings();
    rec.first_mes = g.first.trim();
    rec.alternate_greetings = g.alternates.map((t) => t.trim()).filter(Boolean);
    rec.mes_example = valueOf(field("Example dialogs")).trim();

    if (!rec.personality) errors.push("Personality empty");
    if (!rec.first_mes) errors.push("Initial message empty");

    if (general) general.click(); // tidy up
    return rec;
  }

  // ---------- in-page progress bar ----------
  let bar = null;
  function showBar(text, done = false) {
    if (!bar) {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 8px);z-index:2147483647";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        .b{font:600 13px -apple-system,system-ui,sans-serif;color:#fff;background:#bf5af2;border-radius:999px;padding:8px 8px 8px 14px;
           display:flex;gap:10px;align-items:center;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:88vw}
        .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        button{font:inherit;border:0;border-radius:999px;padding:5px 12px;background:rgba(255,255,255,.25);color:#fff}
      </style><div class="b"><span class="t"></span><button type="button"></button></div>`;
      root.querySelector("button").addEventListener("click", () => {
        const st = load();
        if (st?.status === "running") { st.status = "stopped"; save(st); showBar(`Stopped at ${st.pos}/${st.queue.length}. Open CardScraper to save.`, true); }
        else { host.remove(); bar = null; }
      });
      document.documentElement.append(host);
      bar = { host, root };
    }
    bar.root.querySelector(".t").textContent = "CardScraper · " + text;
    bar.root.querySelector("button").textContent = done ? "✕" : "Stop";
  }

  // ---------- driver ----------
  let driving = false;

  // Problems worth one more try (slow/failed loads), as opposed to genuinely
  // empty fields like "Personality empty".
  const RETRYABLE = /^(Title field not found|Title empty|Page didn't load|Error:|Definition tab not found|Opened “|Couldn't find)/;
  const PAUSE_MS = 1500; // between characters, to go easy on the site

  // Finish the current target: keep the result, or retry it once.
  function finish(st, rec) {
    const retry = rec.errors.some((e) => RETRYABLE.test(e)) && !(st.attempt >= 1);
    if (retry) {
      st.attempt = 1;
    } else {
      if (st.attempt) rec.errors = rec.errors.map((e) => (RETRYABLE.test(e) ? e + " (after retry)" : e));
      st.results.push(rec);
      st.pos++;
      st.attempt = 0;
    }
    save(st);
    return retry;
  }

  function complete(st) {
    if (st.kept) {
      st.results = [...st.kept, ...st.results].sort((a, b) => (a.i ?? 0) - (b.i ?? 0));
      delete st.kept;
    }
    st.status = "done";
    save(st);
    const bad = st.results.filter((r) => r.errors.length).length;
    showBar(`Done: ${st.results.length} characters${bad ? `, ${bad} with problems` : ""}. Open CardScraper to save.`, true);
  }

  async function backToList(st) {
    history.back();
    const back = await waitFor(isListPage, 20000);
    if (!back && st.listUrl) { location.assign(st.listUrl); return false; }
    await sleep(PAUSE_MS);
    return true;
  }

  async function drive() {
    if (driving) return;
    driving = true;
    try {
      for (let guard = 0; guard < 4000; guard++) {
        const st = load();
        if (!st || st.status !== "running") break;
        if (st.pos >= st.queue.length) { complete(st); break; }
        const target = st.queue[st.pos];
        showBar(`${st.pos + 1}/${st.queue.length} · ${target.name || "character"}${st.attempt ? " (retry)" : ""}`);

        const page = await waitFor(() => (isEditPage() ? "edit" : isListPage() ? "list" : null), 25000);

        if (page === "list") {
          const card = await findCardFor(target);
          if (!card) {
            finish(st, { ...target, errors: ["Couldn't find this character in the list"] });
            continue;
          }
          card.btn.scrollIntoView({ block: "center" });
          await sleep(300);
          card.btn.click();
          const ok = await waitFor(isEditPage, 25000);
          if (!ok) {
            if (card.href && !/^javascript:/i.test(card.href)) { location.assign(card.href); break; } // real navigation; resumes after load
            finish(load(), { ...target, errors: ["Page didn't load"] });
          }
          continue;
        }

        if (page === "edit") {
          let rec;
          try {
            rec = await scrapeEditPage(target);
          } catch (e) {
            rec = { ...target, errors: ["Error: " + (e?.message || e)] };
          }
          const now = load();
          if (!now || now.status !== "running") break; // stopped meanwhile
          finish(now, rec);
          if (!(await backToList(now))) break;
          continue;
        }

        // Neither page: count it, then get back to the list.
        finish(st, { ...target, errors: ["Page didn't load"] });
        if (st.listUrl) { location.assign(st.listUrl); break; }
      }
    } finally {
      driving = false;
    }
  }

  // Re-run only the given results (by position), replacing them when done.
  function retry(indices) {
    const st = load();
    if (!st) return false;
    const pick = new Set(indices);
    const redo = st.results.filter((_, k) => pick.has(k));
    if (!redo.length) return false;
    st.kept = st.results.filter((_, k) => !pick.has(k));
    st.queue = redo.map(({ i, name, href, thumb }) => ({ i, name, href, thumb }));
    st.results = [];
    st.pos = 0;
    st.attempt = 0;
    st.status = "running";
    save(st);
    if (!isListPage() && st.listUrl) { location.assign(st.listUrl); return true; }
    drive();
    return true;
  }

  async function start(status) {
    const cards = await loadWholeList(status);
    if (!cards.length) return { ok: false, error: "No characters with an Edit button found on this page." };
    const st = {
      status: "running",
      listUrl: location.href,
      startedAt: Date.now(),
      queue: cards.map(({ i, name, href, thumb }) => ({ i, name, href, thumb })),
      pos: 0,
      results: [],
    };
    save(st);
    drive();
    return { ok: true, count: cards.length };
  }

  function summary() {
    const st = load();
    return {
      page: isEditPage() ? "edit" : isListPage() ? "list" : "other",
      cardsVisible: editButtons().length,
      expected: expectedTotal(),
      status: st?.status || null,
      pos: st?.pos || 0,
      total: st?.queue.length || 0,
      current: st && st.pos < st.queue.length ? st.queue[st.pos].name : null,
    };
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "batchProbe":
        sendResponse(summary());
        return;
      case "batchStart":
        start((t) => showBar(t)).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true;
      case "batchStop": {
        const st = load();
        if (st?.status === "running") { st.status = "stopped"; save(st); showBar(`Stopped at ${st.pos}/${st.queue.length}. Open CardScraper to save.`, true); }
        sendResponse(summary());
        return;
      }
      case "batchResume": {
        const st = load();
        if (st && st.pos < st.queue.length) { st.status = "running"; save(st); drive(); }
        sendResponse(summary());
        return;
      }
      case "batchRetry":
        sendResponse({ ok: retry(msg.indices || []) });
        return;
      case "batchResults":
        sendResponse(load());
        return;
      case "batchClear":
        sessionStorage.removeItem(KEY);
        bar?.host.remove();
        bar = null;
        sendResponse({ ok: true });
        return;
    }
  });

  // Resume after a page load mid-run.
  const st = load();
  if (st?.status === "running") setTimeout(drive, 600);
})();
