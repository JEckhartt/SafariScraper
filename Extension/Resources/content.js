// SafariScraper content script: finds every image URL on the page.
(() => {
  if (window.__safariScraperLoaded) return;
  window.__safariScraperLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)(\?|#|$)/i;
  const LAZY_ATTRS = [
    "data-src", "data-original", "data-lazy-src", "data-lazy", "data-url",
    "data-full", "data-full-src", "data-hi-res-src", "data-large-file",
    "data-orig-file", "data-zoom-src", "data-image", "data-srcset", "data-lazy-srcset",
  ];

  function abs(url) {
    if (!url) return null;
    url = url.trim();
    if (!url || url.startsWith("blob:") || url.startsWith("javascript:")) return null;
    try {
      const u = new URL(url, document.baseURI);
      if (!/^(https?|data):$/.test(u.protocol)) return null;
      if (u.protocol === "data:" && !url.startsWith("data:image/")) return null;
      return u.href;
    } catch {
      return null;
    }
  }

  // Pick the largest candidate from a srcset string.
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

  function scan() {
    const found = new Map(); // url -> {url, width, height, source}
    const add = (raw, width = 0, height = 0, source = "img") => {
      const url = abs(raw);
      if (!url) return;
      const prev = found.get(url);
      if (!prev) found.set(url, { url, width, height, source });
      else if (width * height > prev.width * prev.height) { prev.width = width; prev.height = height; }
    };

    for (const img of document.images) {
      const w = img.naturalWidth, h = img.naturalHeight;
      const srcsetBest = bestFromSrcset(img.getAttribute("srcset"));
      if (srcsetBest) add(srcsetBest, 0, 0, "srcset");
      add(img.currentSrc || img.src, w, h, "img");
      for (const a of LAZY_ATTRS) {
        const v = img.getAttribute(a);
        if (!v) continue;
        add(a.includes("srcset") ? bestFromSrcset(v) : v, 0, 0, "lazy");
      }
    }

    for (const s of document.querySelectorAll("picture source[srcset], source[data-srcset]")) {
      add(bestFromSrcset(s.getAttribute("srcset") || s.getAttribute("data-srcset")), 0, 0, "picture");
    }

    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (IMG_EXT.test(href)) add(href, 0, 0, "link");
    }

    for (const v of document.querySelectorAll("video[poster]")) add(v.getAttribute("poster"), 0, 0, "poster");

    for (const m of document.querySelectorAll(
      'meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], link[rel="image_src"]'
    )) add(m.getAttribute("content") || m.getAttribute("href"), 0, 0, "meta");

    // CSS background images (capped so huge pages don't freeze).
    const all = document.querySelectorAll("body *");
    const limit = Math.min(all.length, 8000);
    for (let i = 0; i < limit; i++) {
      const bg = getComputedStyle(all[i]).backgroundImage;
      if (!bg || bg === "none") continue;
      for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) add(m[1], 0, 0, "css");
    }

    // Inline SVG data URIs and tiny tracking pixels are noise.
    return [...found.values()].filter(
      (x) => !(x.width && x.height && x.width <= 2 && x.height <= 2)
    );
  }

  // Scroll through the page to trigger lazy loading, then come back.
  async function autoScroll() {
    const startY = window.scrollY;
    const step = Math.max(400, window.innerHeight * 0.8);
    let lastHeight = 0, stableRounds = 0;
    for (let i = 0; i < 200 && stableRounds < 3; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 250));
      const h = document.documentElement.scrollHeight;
      const atBottom = window.innerHeight + window.scrollY >= h - 5;
      if (atBottom) {
        stableRounds = h === lastHeight ? stableRounds + 1 : 0;
        await new Promise((r) => setTimeout(r, 500));
      }
      lastHeight = h;
    }
    window.scrollTo(0, startY);
    await new Promise((r) => setTimeout(r, 300));
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "scan") {
      (async () => {
        if (msg.scroll) await autoScroll();
        sendResponse({ images: scan(), title: document.title, url: location.href });
      })();
      return true; // async response
    }
  });
})();
