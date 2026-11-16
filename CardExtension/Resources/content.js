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

  const NAV_LIKE = "nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], " +
    "[role=menu], [role=listbox], [role=dialog], [aria-modal=true], .chakra-portal, [class*=popover], [class*=Popover], " +
    "[class*=popper], [class*=dropdown], [class*=Dropdown], [class*=modal], [class*=Modal], [data-radix-popper-content-wrapper]";

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

  const TEXT_BLOCKS = new Set(["P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "SPAN", "EM", "STRONG", "B", "I", "BR", "HR", "TD", "TR", "DT", "DD"]);

  // Score every element as a possible message list. Real message lists have
  // children that carry a speaker (avatar and/or name label); the paragraphs
  // inside one long message don't, so they can't win anymore.
  function chatCandidates() {
    const out = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.childElementCount < 2 || MD_SKIP.has(el.tagName) || TEXT_BLOCKS.has(el.tagName) || el.closest(NAV_LIKE)) continue;
      const kids = [...el.children].filter((k) => clean(k.textContent).length >= 2 && k.getClientRects().length);
      if (kids.length < 2) continue;
      // The paragraphs of a message, not messages.
      const textish = kids.filter((k) => TEXT_BLOCKS.has(k.tagName)).length;
      if (textish / kids.length > 0.5) continue;
      // Menus/pickers: rows that are buttons.
      const buttony = kids.filter((k) => k.tagName === "BUTTON" || k.querySelector(":scope > button, :scope > a") && clean(k.querySelector(":scope > button, :scope > a").textContent).length >= clean(k.textContent).length * 0.8).length;
      if (buttony / kids.length > 0.5) continue;
      const avgLen = kids.reduce((n, k) => n + clean(k.textContent).length, 0) / kids.length;
      if (avgLen < 12) continue; // menus, tag lists
      let stacked = 0;
      for (let i = 1; i < kids.length; i++) if (kids[i].getBoundingClientRect().top >= kids[i - 1].getBoundingClientRect().bottom - 2) stacked++;
      if (stacked / (kids.length - 1) < 0.7) continue;

      const sample = kids.slice(-40).map((k) => unitOf(k));
      const withAvatar = sample.filter((k) => avatarOf(k)).length / sample.length;
      const withLabel = sample.filter((k) => nameLabel(k)).length / sample.length;
      const msgWords = sample.filter((k) => [k, ...k.querySelectorAll("*")].slice(0, 6).some((e) => attrTokens(e).some((t) => /^(message|messages|msg|chat|turn|post|reply|bubble)$/.test(t)))).length / sample.length;
      const sigs = new Map();
      for (const k of kids) sigs.set(signature(k), (sigs.get(signature(k)) || 0) + 1);
      const top2 = [...sigs.values()].sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
      const consistency = top2 / kids.length;

      const speakerSignal = (1 + 4 * Math.max(withAvatar, withLabel)) * (1 + msgWords);
      const score = kids.length * consistency * consistency * Math.log(avgLen + 1) * speakerSignal;
      out.push({ el, score, kids: kids.length, withAvatar, withLabel, consistency, avgLen });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function findChatContainer() {
    return chatCandidates()[0]?.el || null;
  }

  const INLINE_FMT = new Set(["EM", "I", "B", "STRONG", "CODE", "S", "DEL", "U", "MARK", "SMALL", "SUP", "SUB", "Q", "CITE"]);
  const TIME_RE = /^(\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?|(just now|now|yesterday|today)|\d+\s*(s|sec|m|min|h|hr|d|day|w|wk)s?\s*ago|\d{1,2}\/\d{1,2}\/\d{2,4}.*)$/i;

  // The element holding the message text itself (deepest one with most of the text).
  function bodyOf(msgEl) {
    const total = clean(msgEl.textContent).length;
    if (!total) return null;
    let best = null;
    for (const el of msgEl.querySelectorAll("*")) {
      if (MD_SKIP.has(el.tagName)) continue;
      if (clean(el.textContent).length >= total * 0.6) best = el; // later = deeper in document order
    }
    // Climb back out of a lone paragraph to its container.
    while (best && best !== msgEl && TEXT_BLOCKS.has(best.tagName) && best.parentElement) best = best.parentElement;
    return best && best !== msgEl ? best : null;
  }

  const NAME_TOK = /^(name|names|author|sender|username|nickname|displayname|charname|speaker|persona)$/;
  const looksLikeName = (t) => t && t.length <= 40 && t.split(" ").length <= 5 && !TIME_RE.test(t) &&
    !/^[\d\s/|·•.…-]+$/.test(t) && !/[.!?…"”]$/.test(t);

  // The speaker's name label: a short text outside the message body,
  // preferably in an element whose class says "name".
  function nameLabel(msgEl) {
    const body = bodyOf(msgEl);
    const outside = (n) => !body || !body.contains(n);
    const leaves = [];
    for (const n of msgEl.querySelectorAll("*")) {
      if (MD_SKIP.has(n.tagName) || !outside(n) || n.closest("button, [role=button]")) continue;
      if ([...n.children].some((c) => clean(c.textContent))) continue; // not a text leaf
      const t = clean(n.textContent);
      if (!looksLikeName(t)) continue;
      leaves.push({ el: n, text: t });
      if (leaves.length > 12) break;
    }
    const named = leaves.find((l) => {
      for (let e = l.el; e && e !== msgEl; e = e.parentElement) if (attrTokens(e).some((t) => NAME_TOK.test(t))) return true;
      return false;
    });
    return named || leaves[0] || null;
  }

  // Swipes / alternative replies: several versions side by side with only one
  // on screen. Use the version that's actually showing.
  function unitOf(el) {
    for (let depth = 0; depth < 6; depth++) {
      let choice = null;
      for (const p of [el, ...el.querySelectorAll("*")].slice(0, 200)) {
        const kids = [...p.children].filter((k) => clean(k.textContent).length > 10);
        if (kids.length < 2) continue;
        const sig = signature(kids[0]);
        if (!kids.every((k) => signature(k) === sig)) continue;
        const rects = kids.map((k) => k.getBoundingClientRect());
        const sideBySide = rects.every((r, i) => !i || r.left >= rects[i - 1].right - 2 || r.right <= rects[i - 1].left + 2);
        const sameRow = rects.every((r) => Math.abs(r.top - rects[0].top) < 4);
        if (!sideBySide || !sameRow) continue;
        // The one overlapping the viewport horizontally the most.
        let best = -1, bi = 0;
        rects.forEach((r, i) => {
          const ov = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
          if (ov > best) { best = ov; bi = i; }
        });
        choice = kids[bi];
        break;
      }
      if (!choice) return el;
      el = choice;
    }
    return el;
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

  // Where the label sits inside its message (tag/class path), so a speaker who
  // only wrote once is still recognised by position, not by repetition.
  function labelSignature(el, msgEl) {
    const path = [];
    for (let n = el; n && n !== msgEl && path.length < 4; n = n.parentElement) path.push(signature(n));
    return path.join("<");
  }

  // The speaker's avatar: first small image in the message.
  function avatarOf(msgEl) {
    for (const img of msgEl.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (r.width && r.width <= 160 && r.height <= 160) {
        const src = img.currentSrc || img.src;
        if (src) return src.split("#")[0];
      }
    }
    // CSS background avatars
    for (const el of msgEl.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.width > 160) continue;
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) return m[1];
    }
    return null;
  }

  function messageText(msgEl, label) {
    // Prefer just the message body (no name, swipe counter, buttons).
    const body = bodyOf(msgEl);
    const useBody = body && (!label || !body.contains(label.el));
    const clone = (useBody ? body : msgEl).cloneNode(true);
    if (!useBody && label) {
      // Drop the name label from the copy.
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
      if (t && el.childElementCount === 0 && (TIME_RE.test(t) || /^\d+\s*\/\s*\d+$/.test(t))) el.remove(); // times, "2/3" swipe counters
    }
    // Convert the contents, so a wrapper <li> doesn't turn into a bullet.
    const parts = [...clone.childNodes];
    return { md: toMarkdown(parts), plain: tidy(clone.innerText ?? clone.textContent) || tidy(clone.textContent.replace(/[ \t]+/g, " ")) };
  }

  function snapshot(container) {
    const out = [];
    for (const kid of container.children) {
      if (!clean(kid.textContent) || !kid.getClientRects().length) continue;
      const m = unitOf(kid);
      const label = nameLabel(m);
      const { md, plain } = messageText(m, label);
      if (!plain || !/[\p{L}\p{N}]/u.test(plain)) continue; // "•••" separators, icon rows
      if (!label && plain.length <= 5 && !avatarOf(m)) continue; // tiny unlabeled UI rows
      out.push({
        key: (label?.text || "") + "|" + plain.length + "|" + plain.slice(0, 300),
        label: label?.text || null,
        labelSig: label ? labelSignature(label.el, m) : null,
        avatar: avatarOf(m),
        attr: attrHint(m),
        side: sideOf(m, container),
        md, plain,
      });
    }
    return out;
  }

  // Prepend messages that appeared above what we already have (going up).
  function mergeUp(collected, snap) {
    if (!collected.length) return snap.slice();
    const firstKey = collected[0].key;
    const k = snap.findIndex((m) => m.key === firstKey);
    if (k > 0) return [...snap.slice(0, k), ...collected];
    if (k === 0) return collected;
    const seen = new Set(collected.map((m) => m.key));
    return [...snap.filter((m) => !seen.has(m.key)), ...collected];
  }

  // Append messages that appeared below what we already have (sweeping down).
  function mergeDown(collected, snap) {
    if (!collected.length) return snap.slice();
    const lastKey = collected[collected.length - 1].key;
    for (let j = snap.length - 1; j >= 0; j--) {
      if (snap[j].key === lastKey) return collected.concat(snap.slice(j + 1));
    }
    // No overlap with our last message: keep only genuinely new ones, in order.
    const seen = new Set(collected.map((m) => m.key));
    const fresh = snap.filter((m) => !seen.has(m.key));
    if (fresh.length && fresh.length === snap.length) collected.gap = true;
    return collected.concat(fresh);
  }

  function scrollerFor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const progress = (text) => { try { api.runtime.sendMessage({ type: "chatProgress", text }); } catch {} };
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function scrollModel(scroller) {
    const reversed = getComputedStyle(scroller).flexDirection === "column-reverse" ||
      [...scroller.children].some((c) => getComputedStyle(c).flexDirection === "column-reverse") && scroller.scrollTop <= 0;
    const max = () => scroller.scrollHeight - scroller.clientHeight;
    return {
      // position measured from the top (0 = oldest end)
      get: () => (reversed ? scroller.scrollTop + max() : scroller.scrollTop),
      set: (p) => { scroller.scrollTop = reversed ? p - max() : p; scroller.dispatchEvent(new Event("scroll")); },
      max,
    };
  }

  // Phase 1: go to the top until no older messages load.
  // Phase 2: sweep down one screen at a time, collecting every message, so
  // virtualised lists (only a handful of messages on the page) still export fully.
  async function loadAllMessages(getContainer) {
    let container = getContainer();
    const scroller = scrollerFor(container);
    const pos = scrollModel(scroller);
    const t0 = Date.now();

    // Also collect on the way up, for lists that drop messages for good.
    let upward = snapshot(container);
    let stable = 0, lastH = -1, lastFirst = null;
    for (let i = 0; i < 300 && stable < 3 && Date.now() - t0 < 240_000; i++) {
      pos.set(0);
      await sleep(900);
      await frame();
      if (!container.isConnected) container = getContainer() || container;
      upward = mergeUp(upward, snapshot(container));
      const first = clean(unitOf(container.firstElementChild || container).textContent).slice(0, 120);
      const h = scroller.scrollHeight;
      stable = h === lastH && first === lastFirst && pos.get() < 5 ? stable + 1 : 0;
      lastH = h; lastFirst = first;
      progress(`Loading older messages… (${i + 1})`);
    }

    let collected = [];
    const step = Math.max(200, Math.floor(scroller.clientHeight * 0.6));
    let atBottom = 0, p = 0;
    for (let i = 0; i < 6000 && atBottom < 3 && Date.now() - t0 < 900_000; i++) {
      await frame();
      await sleep(60);
      if (!container.isConnected) container = getContainer() || container;
      collected = mergeDown(collected, snapshot(container));
      if (i % 5 === 0) progress(`Reading messages… ${collected.length} so far`);
      const before = pos.get();
      p = before + step;
      pos.set(p);
      await frame();
      atBottom = pos.get() <= before + 1 ? atBottom + 1 : 0;
    }
    // One last read at the very bottom.
    await sleep(300);
    collected = mergeDown(collected, snapshot(getContainer() || container));
    // Anything only seen on the way up (after where the sweep ended) goes on the end.
    const gap = collected.gap;
    collected = mergeDown(collected, upward);
    collected.gap = gap;
    return collected;
  }

  // Every message is judged on its own evidence. Nothing is inherited from the
  // previous message and nothing alternates: unknown stays unknown (null).
  function resolveSpeakers(msgs, charName) {
    const norm = (x) => clean(x).toLowerCase();
    let method = null;

    // 1. Name labels in the same position as the other name labels.
    const sigCount = new Map();
    for (const m of msgs) if (m.labelSig) sigCount.set(m.labelSig, (sigCount.get(m.labelSig) || 0) + 1);
    const [domSig, domN] = [...sigCount].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    if (domSig && domN >= Math.max(2, msgs.length * 0.3)) {
      for (const m of msgs) m.speaker = m.labelSig === domSig ? m.label : null;
      method = "name labels";
    } else {
      for (const m of msgs) m.speaker = null;
    }

    // 2. Avatars: same picture as a labelled message = same speaker.
    const avatarName = new Map();
    for (const m of msgs) if (m.speaker && m.avatar && !avatarName.has(m.avatar)) avatarName.set(m.avatar, m.speaker);
    let viaAvatar = 0;
    for (const m of msgs) {
      if (!m.speaker && m.avatar && avatarName.has(m.avatar)) { m.speaker = avatarName.get(m.avatar); viaAvatar++; }
    }
    if (!method) {
      // No readable names at all: distinct avatars still separate the speakers.
      const avatars = [...new Set(msgs.map((m) => m.avatar).filter(Boolean))];
      const withAvatar = msgs.filter((m) => m.avatar).length;
      if (avatars.length >= 2 && avatars.length <= 8 && withAvatar >= msgs.length * 0.6) {
        for (const m of msgs) if (m.avatar) m.speaker = `Speaker ${avatars.indexOf(m.avatar) + 1}`;
        method = "avatars";
      }
    } else if (viaAvatar) {
      method += " + avatars";
    }

    const speakers = [...new Set(msgs.map((m) => m.speaker).filter(Boolean))];
    if (speakers.length) {
      // Default roles only; the popup lets the user choose.
      const charSpeaker =
        speakers.find((n) => norm(n) === norm(charName)) ||
        speakers.find((n) => norm(charName) && (norm(n).includes(norm(charName)) || norm(charName).includes(norm(n)))) ||
        speakers[0];
      for (const m of msgs) m.is_user = m.speaker ? m.speaker !== charSpeaker : null;
      // Unnamed leftovers: use only that message's own markers/alignment.
      for (const m of msgs) if (!m.speaker) m.is_user = m.attr ? m.attr > 0 : m.side ? m.side === "R" : null;
      return { method, speakers, charSpeaker };
    }

    // 3. No names or avatars: per-message page markers, then alignment.
    const anyAttr = msgs.some((m) => m.attr > 0) && msgs.some((m) => m.attr < 0);
    const anySide = msgs.some((m) => m.side === "R") && msgs.some((m) => m.side === "L");
    for (const m of msgs) {
      m.is_user = anyAttr && m.attr ? m.attr > 0 : anySide && m.side ? m.side === "R" : null;
    }
    return { method: anyAttr ? "page markers" : anySide ? "bubble alignment" : "nothing (set speakers by hand)", speakers: [] };
  }

  function chatTitleName() {
    const n = scrapeName();
    return n.replace(/^(chat(ting)?\s+with|chat:?)\s+/i, "").trim() || n;
  }

  async function scrapeChat(loadAll) {
    let container = findChatContainer();
    if (!container) return { messages: [], error: "Couldn't find the chat messages on this page." };
    // Keep finding "the same" list even if the page re-renders it.
    const path = pathOf(container);
    const getContainer = () => (container.isConnected ? container : (container = findChatContainer()));
    let collected;
    if (loadAll) {
      collected = await loadAllMessages(getContainer);
    } else {
      collected = snapshot(container);
    }
    const charName = chatTitleName();
    const info = resolveSpeakers(collected, charName);
    return {
      charName,
      speakers: info.speakers,
      charSpeaker: info.charSpeaker || null,
      method: info.method,
      gap: !!collected.gap,
      messages: collected.map(({ md, plain, is_user, speaker }) => ({ md, plain, is_user, speaker: speaker || null })),
      url: location.href,
      path,
    };
  }

  // ---------- debug dump: structure only, text truncated ----------
  function skeleton(node, budget, depth = 0) {
    if (budget.n-- <= 0) return "";
    const ind = "  ".repeat(depth);
    if (node.nodeType === 3) {
      const t = clean(node.textContent);
      return t ? `${ind}"${t.slice(0, 30)}${t.length > 30 ? "…" : ""}"\n` : "";
    }
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style") return "";
    const attrs = [...node.attributes]
      .filter((a) => ["class", "id", "role", "src", "aria-label"].includes(a.name) || a.name.startsWith("data-"))
      .map((a) => `${a.name}="${a.name === "src" ? "[img]" : a.value.slice(0, 80)}"`).join(" ");
    const r = node.getBoundingClientRect();
    const box = ` {${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}}`;
    if (depth > 14 || tag === "svg") return `${ind}<${tag} ${attrs}/>${box}\n`;
    let out = `${ind}<${tag}${attrs ? " " + attrs : ""}>${box}\n`;
    for (const c of node.childNodes) out += skeleton(c, budget, depth + 1);
    return out;
  }

  function pathOf(el) {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 12; n = n.parentElement) {
      parts.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : ""));
    }
    return parts.join(" > ");
  }

  function chatDebug() {
    const cands = chatCandidates().slice(0, 5);
    const lines = [`url-host: ${location.host}`, `viewport: ${innerWidth}x${innerHeight}`, ""];
    cands.forEach((c, i) => {
      lines.push(`## candidate ${i + 1}: score=${c.score.toFixed(1)} kids=${c.kids} avatar=${c.withAvatar.toFixed(2)} label=${c.withLabel.toFixed(2)} consistency=${c.consistency.toFixed(2)} avgLen=${Math.round(c.avgLen)}`);
      lines.push(`path: ${pathOf(c.el)}`);
      const sc = scrollerFor(c.el);
      const st = getComputedStyle(sc);
      lines.push(`scroller: ${pathOf(sc) || sc.tagName} scrollTop=${Math.round(sc.scrollTop)} scrollHeight=${sc.scrollHeight} clientHeight=${sc.clientHeight} overflowY=${st.overflowY} flex=${st.flexDirection}`);
      if (i < 2) {
        const kids = [...c.el.children];
        const pick = [...kids.slice(0, 2), ...kids.slice(-2)].filter((k, j, a) => a.indexOf(k) === j);
        for (const k of pick) {
          const u = unitOf(k);
          lines.push(`--- child ${kids.indexOf(k) + 1}/${kids.length} unit=${u === k ? "self" : pathOf(u).split(" > ").slice(-2).join(" > ")} label=${JSON.stringify(nameLabel(u)?.text ?? null)} avatar=${avatarOf(u) ? "yes" : "no"}`);
          lines.push(skeleton(k, { n: 160 }));
        }
      }
      lines.push("");
    });
    if (!cands.length) lines.push("no candidates found", skeleton(document.body, { n: 600 }));
    return lines.join("\n");
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
    if (msg?.type === "chatDebug") {
      sendResponse({ text: chatDebug() });
      return;
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
