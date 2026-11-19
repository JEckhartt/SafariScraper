// CardScraper batch chat export (JanitorAI "My Chats").
//
// 1. Index: expand each character under "All characters" and list its chats
//    (date, persona chips, message count, preview, link).
// 2. Run: open each selected chat, read the whole history with the regular
//    chat reader, assign speakers from that chat's persona chips, store it,
//    go back, next.
//
// Read-only: it clicks character rows (to expand/collapse) and chat entries,
// and uses Back. It never clicks "Start new chat", delete, or anything else.
// Chat text is stored in this site's IndexedDB (chats are too big for
// sessionStorage); the small run state lives in sessionStorage.
(() => {
  if (window.__cardScraperChatsLoaded) return;
  window.__cardScraperChatsLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const lib = () => globalThis.__cardScraperLib;
  const KEY = "cardscraper-chats";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const norm = (s) => clean(s).toLowerCase();
  const visible = (el) => !!el && el.getClientRects().length > 0;

  async function waitFor(fn, timeout = 15000, interval = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(interval);
    }
    return null;
  }

  // ---------- storage ----------
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } };
  const save = (st) => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { console.warn("CardScraper: state not saved", e); } };

  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("cardscraper", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("chats", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction("chats", mode);
      const out = fn(tx.objectStore("chats"));
      tx.oncomplete = () => res(out?.result);
      tx.onerror = () => rej(tx.error);
    });
  }
  const idbPut = (rec) => idb("readwrite", (s) => s.put(rec));
  const idbGet = (id) => idb("readonly", (s) => s.get(id));
  const idbClear = () => idb("readwrite", (s) => s.clear());

  // ---------- "My Chats" page ----------
  const COUNT_RE = /^chats?:\s*(\d+)$/i;
  const DATE_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(,?\s+\d{4})?$/i;

  function leaves(root, test) {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.childElementCount && [...el.children].some((c) => clean(c.textContent))) continue;
      const t = clean(el.textContent);
      if (t && test(t)) out.push(el);
    }
    return out;
  }

  // Each character row under "All characters" shows "chats: N".
  function charRows() {
    const counts = leaves(document.body, (t) => COUNT_RE.test(t)).filter(visible);
    return counts.map((cEl) => {
      let row = cEl;
      while (row.parentElement && row.parentElement !== document.body) {
        const p = row.parentElement;
        if (leaves(p, (t) => COUNT_RE.test(t)).length > 1) break;
        if (p.querySelector("[data-cs-entry]") || leaves(p, (t) => DATE_RE.test(t)).length) break; // don't swallow the chats list
        row = p;
      }
      const name = leaves(row, (t) => /\p{L}/u.test(t) && !COUNT_RE.test(t) && !/^(un)?published$/i.test(t))[0];
      const toggle = row.querySelector("[aria-expanded]") || row.querySelector("button:has(svg)") || row;
      return { row, name: clean(name?.textContent), count: +clean(cEl.textContent).match(COUNT_RE)[1], toggle,
        expanded: toggle.getAttribute?.("aria-expanded") === "true" };
    });
  }

  function isChatsList() { return charRows().length > 0; }

  // Chat entries: the smallest block holding a date, an "as Persona" chip and
  // a preview. (Smallest, so a character with one chat doesn't swallow its
  // "Start new chat" / "View character" links.)
  function chatEntries() {
    const out = [];
    const seen = new Set();
    const has = (el, test) => leaves(el, test).length > 0;
    for (const d of leaves(document.body, (t) => DATE_RE.test(t)).filter(visible)) {
      let e = d;
      for (let k = 0; k < 8 && e.parentElement; k++) {
        if (has(e, (t) => /^as\s+\S/i.test(t)) && has(e, (t) => t.length > 15 && !DATE_RE.test(t))) break;
        const p = e.parentElement;
        if (leaves(p, (t) => DATE_RE.test(t)).length > 1 || leaves(p, (t) => COUNT_RE.test(t)).length) { e = null; break; }
        e = p;
      }
      if (!e || seen.has(e)) continue;
      seen.add(e);
      const personas = leaves(e, (t) => /^as\s+\S/i.test(t)).map((x) => clean(x.textContent).replace(/^as\s+/i, ""));
      if (!personas.length) continue;
      if (/start new chat|view character/i.test(e.textContent)) continue; // never the character's own controls
      const nums = leaves(e, (t) => /^\d[\d,]*$/.test(t)).map((x) => +clean(x.textContent).replace(/,/g, ""));
      const texts = leaves(e, (t) => t.length > 15).map((x) => clean(x.textContent)).sort((a, b) => b.length - a.length);
      const link = e.closest("a[href]");
      const href = link && !/^(#|javascript:)/i.test(link.getAttribute("href") || "") ? link.href : null;
      out.push({
        el: link || e.closest("button, [role=button]") || e,
        date: clean(d.textContent),
        personas,
        count: nums.length ? Math.max(...nums) : null,
        preview: (texts[0] || "").slice(0, 160),
        href,
      });
    }
    return out;
  }

  // Entries belonging to a row: after it in the page and before the next row.
  function entriesFor(rowIdx) {
    const rows = charRows();
    const row = rows[rowIdx]?.row;
    if (!row) return [];
    const next = rows[rowIdx + 1]?.row;
    return chatEntries().filter((en) => {
      const after = row.compareDocumentPosition(en.el) & Node.DOCUMENT_POSITION_FOLLOWING || row.contains(en.el);
      const before = !next || (en.el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING);
      return after && before;
    });
  }

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

  async function loadAllRows(status) {
    let stable = 0, last = -1;
    for (let i = 0; i < 60 && stable < 3; i++) {
      const n = charRows().length;
      status?.(`Loading characters… ${n}`);
      const sc = scroller();
      sc.scrollTop = sc.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(600);
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
    scroller().scrollTop = 0;
    window.scrollTo(0, 0);
  }

  async function expand(rowIdx) {
    const r = charRows()[rowIdx];
    if (!r) return null;
    if (!entriesFor(rowIdx).length) {
      r.toggle.scrollIntoView({ block: "center" });
      r.toggle.click();
    }
    // Wait until all its chats are listed (or the count stops growing).
    let last = -1, stable = 0;
    await waitFor(() => {
      const n = entriesFor(rowIdx).length;
      stable = n === last ? stable + 1 : 0;
      last = n;
      return (r.count && n >= r.count) || (n > 0 && stable >= 6);
    }, 12000, 250);
    return charRows()[rowIdx];
  }

  async function collapse(rowIdx) {
    const r = charRows()[rowIdx];
    if (r && entriesFor(rowIdx).length) { r.toggle.click(); await sleep(300); }
  }

  async function indexAll(status) {
    await loadAllRows(status);
    const chats = [];
    const rows = charRows();
    for (let r = 0; r < rows.length; r++) {
      const row = await expand(r);
      if (!row) continue;
      status?.(`Finding chats… ${row.name} (${r + 1}/${rows.length})`);
      entriesFor(r).forEach((en, k) => {
        chats.push({
          id: `${r}:${k}:${en.date}:${en.personas.join("+")}:${en.count}`,
          char: row.name, rowIdx: r, k,
          date: en.date, personas: en.personas, count: en.count, preview: en.preview, href: en.href,
          expected: row.count,
        });
      });
      await collapse(r);
    }
    return chats;
  }

  // ---------- chat page ----------
  function isChatPage() {
    if (isChatsList()) return false;
    const c = lib()?.findChatContainer?.();
    return !!(c && c.children.length >= 1);
  }

  // Persona chips = you; everyone else = the character. Unknown → flagged.
  function assignRoles(res, target) {
    const speakers = res.speakers || [];
    const personas = target.personas.map(norm);
    const isPersona = (s) => personas.some((p) => p === norm(s) || p.startsWith(norm(s) + " ") || norm(s).startsWith(p + " "));
    let users = speakers.filter(isPersona);
    if (!users.length && speakers.length === 2) {
      // No exact persona match: the one that isn't the character is you.
      const charLike = speakers.find((s) => norm(target.char).includes(norm(s)) || norm(s).includes(norm(target.char)));
      if (charLike) users = speakers.filter((s) => s !== charLike);
    }
    const msgs = res.messages.map((m) => ({
      md: m.md, plain: m.plain, speaker: m.speaker,
      is_user: m.speaker ? users.includes(m.speaker) : m.is_user,
    }));
    const charNames = speakers.filter((s) => !users.includes(s));
    return { msgs, users, charNames, guessed: !users.length };
  }

  async function scrapeOne(target) {
    const errors = [];
    const res = await lib().scrapeChat(true);
    if (res.error) errors.push(res.error);
    const { msgs, users, charNames, guessed } = assignRoles(res, target);
    if (!msgs.length) errors.push("No messages found");
    if (guessed && msgs.length) errors.push(`Couldn't match persona “${target.personas.join(", ")}” to a speaker (${(res.speakers || []).join(", ") || "none"})`);
    const unknown = msgs.filter((m) => m.is_user == null).length;
    if (unknown) errors.push(`${unknown} message${unknown > 1 ? "s" : ""} with unknown speaker`);
    if (target.count && msgs.length < target.count * 0.95) errors.push(`Got ${msgs.length} of ${target.count} messages`);
    if (res.gap) errors.push("Some messages may have been skipped while scrolling");
    await idbPut({
      id: target.id,
      char: target.char,
      charName: charNames[0] || target.char,
      userName: users[0] || target.personas[0] || "You",
      date: target.date,
      personas: target.personas,
      url: location.href,
      messages: msgs,
    });
    return { id: target.id, char: target.char, date: target.date, personas: target.personas, count: target.count, got: msgs.length, errors };
  }

  // ---------- progress pill ----------
  let bar = null;
  function showBar(text, done = false) {
    if (!bar) {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 8px);z-index:2147483647";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        .b{font:600 13px -apple-system,system-ui,sans-serif;color:#fff;background:#0a84ff;border-radius:999px;padding:8px 8px 8px 14px;
           display:flex;gap:10px;align-items:center;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:88vw}
        .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        button{font:inherit;border:0;border-radius:999px;padding:5px 12px;background:rgba(255,255,255,.25);color:#fff}
      </style><div class="b"><span class="t"></span><button type="button"></button></div>`;
      root.querySelector("button").addEventListener("click", () => {
        const st = load();
        if (st?.status === "running") { st.status = "stopped"; save(st); showBar(`Stopped at ${st.pos}/${st.queue.length}. Open CardScraper to save or resume.`, true); }
        else { host.remove(); bar = null; }
      });
      document.documentElement.append(host);
      bar = { host, root };
    }
    bar.root.querySelector(".t").textContent = "CardScraper · " + text;
    bar.root.querySelector("button").textContent = done ? "✕" : "Stop";
  }

  // ---------- driver ----------
  const RETRYABLE = /^(No messages found|Chat didn't open|Couldn't find this chat|Error:)/;
  let driving = false;

  function finish(st, rec) {
    st.opened = null;
    const retry = rec.errors.some((e) => RETRYABLE.test(e)) && !(st.attempt >= 1);
    if (retry) {
      st.attempt = 1;
    } else {
      if (st.attempt) rec.errors = rec.errors.map((e) => (RETRYABLE.test(e) ? e + " (after retry)" : e));
      st.results = st.results.filter((r) => r.id !== rec.id).concat(rec);
      st.pos++;
      st.attempt = 0;
    }
    save(st);
  }

  async function toList(st) {
    if (isChatsList()) return true;
    history.back();
    if (await waitFor(isChatsList, 20000)) { await sleep(1200); return true; }
    if (st.listUrl) location.assign(st.listUrl);
    return false;
  }

  async function open(target) {
    await loadAllRows();
    const row = await expand(target.rowIdx);
    if (!row || (target.char && row.name !== target.char)) return null;
    const en = entriesFor(target.rowIdx).find((e) => e.date === target.date && e.personas.join("+") === target.personas.join("+") &&
      (target.count == null || e.count === target.count)) || entriesFor(target.rowIdx)[target.k];
    if (!en) return null;
    en.el.scrollIntoView({ block: "center" });
    await sleep(250);
    en.el.click();
    return "clicked";
  }

  async function drive() {
    if (driving) return;
    driving = true;
    globalThis.__cardScraperOnProgress = (t) => {
      const st = load();
      if (st?.status === "running") showBar(`${st.pos + 1}/${st.queue.length} · ${st.queue[st.pos]?.char} · ${t}`);
    };
    try {
      for (let guard = 0; guard < 5000; guard++) {
        const st = load();
        if (!st || st.status !== "running") break;
        if (st.pos >= st.queue.length) {
          const order = new Map((st.index || []).map((c, i) => [c.id, i]));
          st.results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
          st.status = "done";
          save(st);
          const bad = st.results.filter((r) => r.errors.length).length;
          showBar(`Done: ${st.results.length} chats${bad ? `, ${bad} with problems` : ""}. Open CardScraper to save.`, true);
          break;
        }
        const target = st.queue[st.pos];
        showBar(`${st.pos + 1}/${st.queue.length} · ${target.char} · ${target.date}${st.attempt ? " (retry)" : ""}`);
        const fail = (msg) => ({ id: target.id, char: target.char, date: target.date, personas: target.personas, count: target.count, got: 0, errors: [msg] });

        // Direct link: go there (once per attempt); the next page resumes the run.
        if (target.href && st.opened !== target.id) {
          st.opened = target.id;
          save(st);
          await sleep(800);
          location.assign(target.href);
          break;
        }

        const where = await waitFor(() => (isChatsList() ? "list" : isChatPage() ? "chat" : null), 25000);

        if (where === "chat" && st.opened === target.id) {
          await sleep(1500); // let the newest messages settle
          let rec;
          try { rec = await scrapeOne(target); }
          catch (e) { rec = fail("Error: " + (e?.message || e)); }
          const now = load();
          if (!now || now.status !== "running") break;
          finish(now, rec);
          const next = now.queue[now.pos];
          if (next && !next.href && !(await toList(now))) break;
          continue;
        }

        if (where === "chat") { if (!(await toList(st))) break; continue; } // some other chat open

        if (where === "list" && !target.href) {
          st.opened = target.id;
          save(st);
          const how = await open(target);
          if (!how) {
            finish(load(), fail("Couldn't find this chat in the list"));
            continue;
          }
          if (!(await waitFor(isChatPage, 25000))) {
            const now = load();
            finish(now, fail("Chat didn't open"));
            if (!(await toList(now))) break;
          }
          continue;
        }

        // The chat never showed up (or we're somewhere unexpected).
        const now = load();
        finish(now, fail("Chat didn't open"));
        const next = now.queue[now.pos];
        if (next && !next.href && !isChatsList() && now.listUrl) { location.assign(now.listUrl); break; }
      }
    } finally {
      driving = false;
    }
  }

  function summary() {
    const st = load();
    return {
      page: isChatsList() ? "chatslist" : "other",
      rows: charRows().length,
      status: st?.status || null,
      indexed: !!st?.index,
      pos: st?.pos || 0,
      total: st?.queue?.length || 0,
      current: st && st.queue && st.pos < st.queue.length ? `${st.queue[st.pos].char} · ${st.queue[st.pos].date}` : null,
    };
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "chatsProbe":
        sendResponse(summary());
        return;
      case "chatsIndex":
        indexAll((t) => showBar(t)).then(async (chats) => {
          const st = { status: null, listUrl: location.href, index: chats, queue: [], pos: 0, results: [] };
          save(st);
          showBar(`Found ${chats.length} chats. Pick them in CardScraper.`, true);
          sendResponse({ ok: true, chats });
        }, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true;
      case "chatsStart": {
        const st = load();
        if (!st?.index) { sendResponse({ ok: false, error: "Find the chats first." }); return; }
        const pick = new Set(msg.ids || []);
        const keep = msg.keepResults ? st.results.filter((r) => !pick.has(r.id)) : [];
        st.queue = st.index.filter((c) => pick.has(c.id));
        st.results = keep;
        st.pos = 0;
        st.attempt = 0;
        st.status = "running";
        save(st);
        sendResponse({ ok: true, count: st.queue.length });
        drive();
        return;
      }
      case "chatsStop": {
        const st = load();
        if (st?.status === "running") { st.status = "stopped"; save(st); showBar(`Stopped at ${st.pos}/${st.queue.length}. Open CardScraper to save or resume.`, true); }
        sendResponse(summary());
        return;
      }
      case "chatsResume": {
        const st = load();
        if (st && st.pos < st.queue.length) { st.status = "running"; save(st); drive(); }
        sendResponse(summary());
        return;
      }
      case "chatsState":
        sendResponse(load());
        return;
      case "chatsGet":
        idbGet(msg.id).then(sendResponse, () => sendResponse(null));
        return true;
      case "chatsClear":
        sessionStorage.removeItem(KEY);
        idbClear().finally(() => { bar?.host.remove(); bar = null; sendResponse({ ok: true }); });
        return true;
    }
  });

  // Resume after a page load mid-run.
  if (load()?.status === "running") setTimeout(drive, 800);
})();
