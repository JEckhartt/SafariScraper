// CardScraper content script: finds the main (largest) image and the
// Scenario / Personality / First message / Example dialogs sections.
(() => {
  if (window.__cardScraperLoaded) return;
  window.__cardScraperLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const FIELDS = [
    { key: "scenario", re: /^scenario$/i },
    { key: "personality", re: /^(personality|personality summary|character personality)$/i },
    { key: "first_mes", re: /^(first message|first mes|greeting|intro message|initial message)$/i },
    { key: "creator_notes", re: /^(public description|description|about|about me|bio|tagline|overview|creator'?s? notes?)$/i },
    { key: "mes_example", re: /^(example dialog(ue)?s?|example messages?|example chats?|dialog(ue)? examples?)$/i },
  ];

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // "Personality (1,234 tokens)" / "SCENARIO:" / "First Message — 300 tokens" -> "personality"
  function headingLabel(text) {
    return clean(text)
      .replace(/[\(\[].*?(tokens?|chars?|characters|words).*?[\)\]]/gi, "")
      .replace(/[-–—·•|]\s*[\d,.]+\s*(tokens?|chars?|characters|words)\b.*/gi, "")
      .replace(/\b[\d,.]+\s*(tokens?|chars?)\b/gi, "")
      .replace(/[:：]\s*$/, "")
      .trim();
  }

  function fieldFor(el) {
    const t = el.textContent;
    if (!t || t.length > 80) return null;
    const label = headingLabel(t);
    if (!label || label.length > 40) return null;
    return FIELDS.find((f) => f.re.test(label)) || null;
  }

  // Readable text with line breaks, even for collapsed/hidden sections.
  function textOf(el) {
    // innerText only keeps line breaks for rendered elements.
    if (el.getClientRects().length > 0) {
      const visible = el.innerText;
      if (visible && visible.trim()) return visible;
    }
    // Hidden: rebuild breaks from block elements.
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
    clone.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr").forEach((b) => b.append("\n"));
    return clone.textContent;
  }

  function tidy(s) {
    return (s || "")
      .replace(/\r/g, "")
      .replace(/[ \t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function findHeadings() {
    // Outermost element whose whole text is a section label.
    const out = [];
    const all = document.body.querySelectorAll("*:not(script):not(style):not(noscript)");
    for (const el of all) {
      const f = fieldFor(el);
      if (!f) continue;
      const parent = el.parentElement;
      if (parent && fieldFor(parent)) continue; // parent is the better (outer) match
      out.push({ el, key: f.key, hasTokens: /\btokens?\b/i.test(el.textContent) });
    }
    return out;
  }

  // Nodes (elements and bare text) that make up a section's body.
  function contentNodesAfter(heading, allHeadingEls) {
    const isHeadingOrHasHeading = (n) =>
      n.nodeType === 1 && allHeadingEls.some((h) => h !== heading && (n === h || n.contains(h)));

    let node = heading;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      const nodes = [];
      for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
        if (isHeadingOrHasHeading(sib)) break;
        if (sib.nodeType === 1 || sib.nodeType === 3) nodes.push(sib);
      }
      if (nodes.some((n) => n.textContent.trim())) return nodes;
      // Nothing after us at this level: the heading probably sits in its own
      // header wrapper, so climb out of it (unless that would swallow another section).
      const parent = node.parentElement;
      if (!parent || isHeadingOrHasHeading(parent)) break;
      node = parent;
    }
    return [];
  }

  const plainOf = (nodes) => tidy(nodes.map((n) => (n.nodeType === 3 ? n.textContent : textOf(n))).join("\n"));
  const markdownOf = (nodes) => toMarkdown(nodes);

  function scrapeText(mainImg) {
    let headings = findHeadings();
    // Real section headers show a token count ("PERSONALITY (940 TOKENS)").
    // When the page has those, ignore look-alike labels inside the text
    // ("Personality:", "### Scenario") so they stay part of the section.
    const tokenHeads = headings.filter((h) => h.hasTokens && h.key !== "creator_notes");
    if (tokenHeads.length) headings = tokenHeads;
    const els = headings.map((h) => h.el);
    const plain = {}, md = {};
    const firstSection = headings.find((h) => h.key !== "creator_notes")?.el;
    for (const h of headings) {
      if (plain[h.key]) continue; // first occurrence wins
      const nodes = contentNodesAfter(h.el, els);
      const text = plainOf(nodes);
      if (text) {
        plain[h.key] = text;
        md[h.key] = markdownOf(nodes) || text;
      }
    }
    if (!plain.creator_notes) {
      const node = descriptionNear(mainImg, firstSection);
      if (node) {
        plain.creator_notes = plainOf([node]);
        md.creator_notes = markdownOf([node]) || plain.creator_notes;
      } else {
        plain.creator_notes = md.creator_notes = metaDescription();
      }
    }
    return { plain, md };
  }

  // ---------- HTML -> Markdown ----------
  const MD_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "BUTTON", "SVG", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "IMG", "PICTURE", "TEMPLATE"]);
  const BLOCKISH = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "FORM", "FIELDSET", "DETAILS", "SUMMARY", "CENTER", "ADDRESS"]);

  function wrapInline(marker, inner) {
    if (!inner.trim()) return inner;
    const lead = inner.match(/^\s*/)[0];
    const trail = inner.match(/\s*$/)[0];
    const core = inner.trim();
    // Don't double up if the site already shows the literal markers.
    if (core.startsWith(marker) && core.endsWith(marker) && core.length > marker.length * 2) return inner;
    return `${lead}${marker}${core}${marker}${trail}`;
  }

  function styleMarkers(el) {
    // Sites sometimes style spans instead of using <em>/<strong>.
    const st = el.getAttribute("style") || "";
    let m = "";
    if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) m += "**";
    if (/font-style\s*:\s*italic/i.test(st)) m += "*";
    return m;
  }

  function mdNode(node, ctx) {
    if (node.nodeType === 3) {
      return ctx.pre ? node.textContent : node.textContent.replace(/[ \t\r\n\u00a0]+/g, " ");
    }
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toUpperCase();
    if (MD_SKIP.has(tag)) return "";
    if (node.getAttribute("aria-hidden") === "true") return "";

    const kids = (c = ctx) => [...node.childNodes].map((n) => mdNode(n, c)).join("");

    switch (tag) {
      case "BR": return "\n";
      case "HR": return "\n\n---\n\n";
      case "P": return `\n\n${kids().trim()}\n\n`;
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
        const t = kids().trim();
        return t ? `\n\n${"#".repeat(+tag[1])} ${t}\n\n` : "";
      }
      case "STRONG": case "B": return wrapInline("**", kids());
      case "EM": case "I": case "CITE": case "DFN": return wrapInline("*", kids());
      case "DEL": case "S": case "STRIKE": return wrapInline("~~", kids());
      case "CODE": return ctx.pre ? kids() : wrapInline("`", kids());
      case "PRE": {
        const t = kids({ ...ctx, pre: true }).replace(/\n+$/, "");
        return `\n\n\`\`\`\n${t}\n\`\`\`\n\n`;
      }
      case "BLOCKQUOTE": {
        const t = tidyMd(kids());
        return t ? `\n\n${t.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n` : "";
      }
      case "UL": case "OL": {
        const ordered = tag === "OL";
        let i = Number(node.getAttribute("start")) || 1;
        const items = [];
        for (const li of node.children) {
          if (li.tagName.toUpperCase() !== "LI") continue;
          const bullet = ordered ? `${i++}. ` : "- ";
          const body = tidyMd([...li.childNodes].map((n) => mdNode(n, ctx)).join(""))
            .replace(/\n{2,}(?=[ \t]*(?:[-*+]|\d+\.) )/g, "\n"); // keep nested lists tight
          const pad = " ".repeat(bullet.length);
          items.push(bullet + body.split("\n").map((l, j) => (j && l ? pad + l : l)).join("\n"));
        }
        return items.length ? `\n\n${items.join("\n")}\n\n` : "";
      }
      case "LI": return `\n- ${kids().trim()}\n`; // stray <li> outside a list
      case "A": {
        const t = kids();
        const href = node.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || !t.trim()) return t;
        let url;
        try { url = new URL(href, document.baseURI).href; } catch { return t; }
        return t.trim() === url ? url : `[${t.trim()}](${url})`;
      }
      case "TABLE": {
        const rows = [...node.querySelectorAll("tr")].map((tr) =>
          "| " + [...tr.children].map((c) => tidyMd(mdNode(c, ctx)).replace(/\n/g, " ")).join(" | ") + " |");
        if (!rows.length) return "";
        const cols = node.querySelector("tr").children.length;
        rows.splice(1, 0, "|" + " --- |".repeat(cols));
        return `\n\n${rows.join("\n")}\n\n`;
      }
      case "TD": case "TH": return kids();
      default: {
        const m = styleMarkers(node);
        let t = kids();
        if (m) t = wrapInline(m, t);
        return BLOCKISH.has(tag) ? `\n${t}\n` : t;
      }
    }
  }

  // Normalise blank lines/indentation, leaving fenced code blocks untouched.
  function tidyMd(s) {
    return s
      .split(/(```[\s\S]*?\n```)/)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/[ \t]+\n/g, "\n")
              .replace(/\n[ \t]+(?![ \t]|(?:[-*+]|\d+\.) )/g, "\n")
              .replace(/^[ \t]+/, "")
              .replace(/\n{3,}/g, "\n\n"))
      .join("")
      .trim();
  }

  function toMarkdown(nodes) {
    return tidyMd(nodes.map((n) => mdNode(n, { pre: false })).join("\n"));
  }

  function bestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null, bestScore = -1;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [url, desc = "1x"] = part.trim().split(/\s+/);
      const n = parseFloat(desc) || 1;
      const score = desc.endsWith("w") ? n : n * 1000;
      if (score > bestScore) { bestScore = score; best = url; }
    }
    return best;
  }

  function abs(url) {
    try {
      const u = new URL(url, document.baseURI);
      return /^(https?|data):$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  function scrapeImages() {
    const list = [];
    const seen = new Set();
    const push = (url, w, h, displayed, el = null) => {
      url = abs(url);
      if (!url || seen.has(url)) return;
      seen.add(url);
      list.push({ url, width: w, height: h, displayed, el });
    };
    for (const img of document.images) {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w * h < 100 * 100) continue;
      const r = img.getBoundingClientRect();
      const displayed = Math.round(r.width * r.height);
      push(bestFromSrcset(img.getAttribute("srcset")) || img.currentSrc || img.src, w, h, displayed, img);
    }
    const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    if (og) push(og, 0, 0, 0);
    // Largest on screen first, then largest natural size.
    list.sort((a, b) => b.displayed - a.displayed || b.width * b.height - a.width * a.height);
    return list.slice(0, 12);
  }

  // The public description: the biggest block of text between the main image
  // and the first definition section (Scenario, Personality, …).
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "BUTTON", "NAV", "INPUT", "TEXTAREA", "SELECT", "SVG", "IMG", "HEADER", "FOOTER"]);

  function descriptionNear(imgEl, stopEl) {
    if (!imgEl) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = imgEl;
    const cands = [];
    let n, steps = 0;
    while ((n = walker.nextNode()) && steps++ < 6000) {
      if (stopEl && (n === stopEl || n.contains(stopEl))) {
        if (n === stopEl) break;
        continue; // ancestor of the stop heading: too big, but keep walking into it
      }
      if (SKIP.has(n.tagName) || n.closest("button, nav, a[href], [role=button]")) continue;
      if (n.getClientRects().length === 0) continue;
      const len = clean(n.textContent).length;
      if (len >= 40) cands.push({ n, len });
    }
    if (!cands.length) return null;
    const max = Math.max(...cands.map((c) => c.len));
    // Deepest element that still holds (nearly) all of the biggest block.
    const good = cands.filter((c) => c.len >= max * 0.85);
    const best = good.reduce((a, b) => (a.n.contains(b.n) ? b : a));
    return best.n;
  }

  function metaDescription() {
    const m = document.querySelector('meta[property="og:description"], meta[name="description"]');
    return tidy(m?.getAttribute("content") || "");
  }

  function scrapeName() {
    const cand = [
      document.querySelector("h1")?.innerText,
      document.querySelector('meta[property="og:title"]')?.getAttribute("content"),
      document.title,
    ];
    for (let c of cand) {
      c = clean(c).split(/\s+[|\-–—]\s+/)[0];
      if (c && c.length <= 80) return c;
    }
    return "Character";
  }

  // ======================= CHAT EXPORT =======================

  const NAV_LIKE = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], form";

  // Class/id/data-* tokens, camelCase split: "MessageUser_bubble" -> message, user, bubble
  function attrTokens(el) {
    const parts = [el.id, typeof el.className === "string" ? el.className : el.getAttribute("class") || ""];
    for (const a of el.attributes) if (a.name.startsWith("data-") || a.name === "role" || a.name === "aria-label") parts.push(a.name, a.value);
    return parts.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  const USER_TOK = new Set(["user", "human", "self", "me", "mine", "own", "outgoing", "outbound", "sent", "right", "persona", "you", "player"]);
  const BOT_TOK = new Set(["bot", "char", "character", "assistant", "ai", "model", "incoming", "inbound", "received", "left", "npc", "llm"]);

  function attrHint(msgEl) {
    let u = 0, b = 0;
    const els = [msgEl, ...msgEl.querySelectorAll("*")].slice(0, 40);
    for (const el of els) {
      for (const t of attrTokens(el)) {
        if (USER_TOK.has(t)) u++;
        if (BOT_TOK.has(t)) b++;
      }
    }
    return u > b ? 1 : b > u ? -1 : 0;
  }

  function signature(el) {
    const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/)
      .filter((c) => c && !/(user|bot|char|human|assistant|ai|self|me|left|right|active|selected|last|first|new|odd|even)/i.test(c))
      .sort().join(".");
    return el.tagName + "." + cls;
  }

  function findChatContainer() {
    let best = null, bestScore = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (el.childElementCount < 2 || MD_SKIP.has(el.tagName) || el.closest(NAV_LIKE)) continue;
      const kids = [...el.children].filter((k) => clean(k.textContent).length >= 2 && k.getClientRects().length);
      if (kids.length < 2) continue;
      const sigs = new Map();
      for (const k of kids) sigs.set(signature(k), (sigs.get(signature(k)) || 0) + 1);
      const top2 = [...sigs.values()].sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
      const consistency = top2 / kids.length;
      const avgLen = kids.reduce((n, k) => n + clean(k.textContent).length, 0) / kids.length;
      if (avgLen < 12) continue; // menus, tag lists
      // Messages stack vertically.
      let stacked = 0;
      for (let i = 1; i < kids.length; i++) if (kids[i].getBoundingClientRect().top >= kids[i - 1].getBoundingClientRect().bottom - 2) stacked++;
      const vertical = stacked / (kids.length - 1);
      if (vertical < 0.7) continue;
      const score = kids.length * consistency * consistency * Math.log(avgLen + 1);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  const INLINE_FMT = new Set(["EM", "I", "B", "STRONG", "CODE", "S", "DEL", "U", "MARK", "SMALL", "SUP", "SUB", "Q", "CITE"]);
  const TIME_RE = /^(\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?|(just now|now|yesterday|today)|\d+\s*(s|sec|m|min|h|hr|d|day|w|wk)s?\s*ago|\d{1,2}\/\d{1,2}\/\d{2,4}.*)$/i;

  // First short leaf text in a message: often the speaker's name.
  function nameLabel(msgEl) {
    const walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_ELEMENT);
    let n, i = 0;
    while ((n = walker.nextNode()) && i++ < 30) {
      if (MD_SKIP.has(n.tagName)) continue;
      if ([...n.children].some((c) => clean(c.textContent))) continue; // not a text leaf
      // Formatting inside the message text (*grunts*) is content, not a name.
      if (INLINE_FMT.has(n.tagName) || n.parentElement?.closest("p, li, blockquote, pre, td") || /^(P|LI|BLOCKQUOTE|PRE|TD)$/.test(n.tagName)) {
        if (clean(n.parentElement?.textContent).length > clean(n.textContent).length || /^(P|LI|BLOCKQUOTE|PRE|TD)$/.test(n.tagName)) return null;
      }
      const t = clean(n.textContent);
      if (!t) continue;
      if (TIME_RE.test(t)) continue;
      if (t.length <= 40 && t.split(" ").length <= 5 && !/[.!?…"]$/.test(t)) return { el: n, text: t };
      return null; // first real text is message content
    }
    return null;
  }

  function sideOf(msgEl, container) {
    const c = container.getBoundingClientRect();
    if (c.width < 50) return null;
    // Widest text-holding descendant narrower than the container = the bubble.
    let bubble = null, bw = 0;
    for (const el of [msgEl, ...msgEl.querySelectorAll("*")].slice(0, 60)) {
      const r = el.getBoundingClientRect();
      if (r.width < c.width * 0.92 && r.width > bw && clean(el.textContent).length > 3) { bubble = r; bw = r.width; }
    }
    if (!bubble) return null;
    const leftGap = bubble.left - c.left, rightGap = c.right - bubble.right;
    if (Math.abs(leftGap - rightGap) < c.width * 0.08) return null;
    return rightGap < leftGap ? "R" : "L";
  }

  function messageText(msgEl, label) {
    const clone = msgEl.cloneNode(true);
    // Drop the name label, timestamps and UI chrome from the copy.
    if (label) {
      const path = [];
      for (let n = label.el; n && n !== msgEl; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
      let c = clone;
      for (const i of path) c = c?.childNodes[i];
      c?.remove();
    }
    for (const el of clone.querySelectorAll("time, button, [role=button], svg, [aria-hidden=true]")) el.remove();
    for (const el of clone.querySelectorAll("*")) {
      if (!clone.contains(el)) continue; // already removed with an ancestor
      const t = clean(el.textContent);
      if (t && TIME_RE.test(t) && el.childElementCount === 0) el.remove();
    }
    return { md: toMarkdown([clone]), plain: tidy(clone.textContent.replace(/[ \t]+/g, " ")) };
  }

  function snapshot(container) {
    const out = [];
    for (const m of container.children) {
      if (!clean(m.textContent) || !m.getClientRects().length) continue;
      const label = nameLabel(m);
      const { md, plain } = messageText(m, label);
      if (!plain) continue;
      out.push({ key: plain.slice(0, 200), label: label?.text || null, attr: attrHint(m), side: sideOf(m, container), md, plain });
    }
    return out;
  }

  // Prepend messages that appeared above what we already have.
  function merge(collected, snap) {
    if (!collected.length) return snap;
    const first = collected[0].key;
    const k = snap.findIndex((m) => m.key === first);
    if (k > 0) return [...snap.slice(0, k), ...collected];
    if (k === 0) return collected;
    // No overlap: a jump. Keep whichever is longer, older first.
    return snap.length > collected.length ? snap : [...snap, ...collected];
  }

  function scrollerFor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadHistory(container, collect) {
    const scroller = scrollerFor(container);
    const reversed = getComputedStyle(scroller).flexDirection === "column-reverse" ||
      getComputedStyle(container).flexDirection === "column-reverse";
    let stable = 0, lastH = -1, lastFirst = null;
    const t0 = Date.now();
    for (let i = 0; i < 400 && stable < 4 && Date.now() - t0 < 180_000; i++) {
      scroller.scrollTop = reversed ? -scroller.scrollHeight : 0;
      scroller.dispatchEvent(new Event("scroll"));
      await sleep(700);
      if (!container.isConnected) container = findChatContainer() || container;
      collect(container);
      const first = clean(container.firstElementChild?.textContent).slice(0, 80);
      const h = scroller.scrollHeight;
      stable = h === lastH && first === lastFirst ? stable + 1 : 0;
      lastH = h; lastFirst = first;
    }
    return container;
  }

  function resolveSpeakers(msgs, charName) {
    const norm = (s) => clean(s).toLowerCase();
    const cn = norm(charName);
    // 1. Name labels that repeat.
    const freq = new Map();
    for (const m of msgs) if (m.label) freq.set(m.label, (freq.get(m.label) || 0) + 1);
    const names = [...freq].filter(([, n]) => n >= 2).map(([l]) => l);
    const labelled = msgs.filter((m) => m.label && names.includes(m.label)).length;
    if (names.length >= 1 && names.length <= 6 && labelled >= msgs.length * 0.6) {
      let charLabel = names.find((l) => norm(l) === cn) ||
        names.find((l) => cn && (norm(l).includes(cn) || cn.includes(norm(l))));
      if (!charLabel && names.length >= 2) charLabel = msgs.find((m) => names.includes(m.label))?.label;
      if (charLabel) {
        let last = false;
        for (const m of msgs) {
          if (m.label && names.includes(m.label)) last = m.label !== charLabel;
          m.is_user = last;
        }
        const userName = names.find((l) => l !== charLabel) || null;
        return { method: "name labels", charName: charLabel, userName };
      }
    }
    // 2. user/bot markers in the page code.
    const u = msgs.filter((m) => m.attr > 0).length, b = msgs.filter((m) => m.attr < 0).length;
    if (u && b && u + b >= msgs.length * 0.6) {
      for (const m of msgs) m.is_user = m.attr > 0;
      return { method: "page markers" };
    }
    // 3. Bubble alignment.
    const R = msgs.filter((m) => m.side === "R").length, L = msgs.filter((m) => m.side === "L").length;
    if (R && L && R + L >= msgs.length * 0.6) {
      for (const m of msgs) m.is_user = m.side === "R";
      return { method: "bubble alignment" };
    }
    // 4. Alternate, character first.
    msgs.forEach((m, i) => (m.is_user = i % 2 === 1));
    return { method: "alternating (guess)" };
  }

  function chatTitleName() {
    const n = scrapeName();
    return n.replace(/^(chat(ting)?\s+with|chat:?)\s+/i, "").trim() || n;
  }

  async function scrapeChat(loadAll) {
    let container = findChatContainer();
    if (!container) return { messages: [], error: "Couldn't find the chat messages on this page." };
    let collected = [];
    const collect = (c) => { collected = merge(collected, snapshot(c)); };
    collect(container);
    if (loadAll) {
      container = await loadHistory(container, collect);
      // Back to the newest messages.
      const sc = scrollerFor(container);
      sc.scrollTop = getComputedStyle(sc).flexDirection === "column-reverse" ? 0 : sc.scrollHeight;
    }
    const charName = chatTitleName();
    const info = resolveSpeakers(collected, charName);
    return {
      charName: info.charName || charName,
      userName: info.userName || "You",
      method: info.method,
      messages: collected.map(({ md, plain, is_user, label }) => ({ md, plain, is_user, label })),
      url: location.href,
    };
  }

  function chatLikely() {
    if (findHeadings().some((h) => h.hasTokens)) return false;
    const c = findChatContainer();
    return !!c && (/chat|conversation|messages?/i.test(location.pathname) || c.childElementCount >= 4);
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "chat") {
      scrapeChat(!!msg.loadAll).then(sendResponse, (e) => sendResponse({ messages: [], error: String(e?.message || e) }));
      return true;
    }
    if (msg?.type === "chatProbe") {
      sendResponse({ chat: chatLikely() });
      return;
    }
    if (msg?.type !== "card") return;
    const images = scrapeImages();
    const mainImg = images.find((i) => i.el)?.el || null;
    const { plain, md } = scrapeText(mainImg);
    sendResponse({
      name: scrapeName(),
      fields: md,
      plainFields: plain,
      images: images.map(({ el, ...rest }) => rest),
      url: location.href,
    });
  });
})();
