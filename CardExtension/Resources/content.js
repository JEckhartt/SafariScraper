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
      out.push({ el, key: f.key });
    }
    return out;
  }

  function contentAfter(heading, allHeadingEls) {
    const isHeadingOrHasHeading = (n) =>
      allHeadingEls.some((h) => h !== heading && (n === h || n.contains(h)));

    let node = heading;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      const parts = [];
      for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (isHeadingOrHasHeading(sib)) break;
        const t = textOf(sib);
        if (t && t.trim()) parts.push(t);
      }
      const text = tidy(parts.join("\n"));
      if (text) return text;
      // Nothing after us at this level: the heading probably sits in its own
      // header wrapper, so climb out of it (unless that would swallow another section).
      const parent = node.parentElement;
      if (!parent || isHeadingOrHasHeading(parent)) break;
      node = parent;
    }
    return "";
  }

  function scrapeText() {
    const headings = findHeadings();
    const els = headings.map((h) => h.el);
    const fields = {};
    for (const h of headings) {
      if (fields[h.key]) continue; // first occurrence wins
      const text = contentAfter(h.el, els);
      if (text) fields[h.key] = text;
    }
    return fields;
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
    const push = (url, w, h, displayed) => {
      url = abs(url);
      if (!url || seen.has(url)) return;
      seen.add(url);
      list.push({ url, width: w, height: h, displayed });
    };
    for (const img of document.images) {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w * h < 100 * 100) continue;
      const r = img.getBoundingClientRect();
      const displayed = Math.round(r.width * r.height);
      push(bestFromSrcset(img.getAttribute("srcset")) || img.currentSrc || img.src, w, h, displayed);
    }
    const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    if (og) push(og, 0, 0, 0);
    // Largest on screen first, then largest natural size.
    list.sort((a, b) => b.displayed - a.displayed || b.width * b.height - a.width * a.height);
    return list.slice(0, 12);
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

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "card") return;
    sendResponse({
      name: scrapeName(),
      fields: scrapeText(),
      images: scrapeImages(),
      url: location.href,
    });
  });
})();
