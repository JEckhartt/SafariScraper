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
      out.push({ el, key: f.key });
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
    const headings = findHeadings();
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

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
