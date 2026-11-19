// Talking to the current tab, with errors that say *why* it failed
// (private tab, no site access, script blocked…) instead of a generic message.

const api = globalThis.browser ?? globalThis.chrome;

async function activeTab() {
  let [tab] = await api.tabs.query({ active: true, currentWindow: true });
  // Some Safari versions report private windows oddly; fall back to the last focused one.
  if (!tab) [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function describe(tab) {
  const kind = tab.incognito ? "private tab" : "normal tab";
  let site = "no access to this site's address";
  try { if (tab.url) site = new URL(tab.url).host; } catch {}
  return `${kind}, ${site}`;
}

export async function sendToPage(msg) {
  const tab = await activeTab();
  if (!tab) throw new Error("CardScraper can't see any open tab. Close this and tap CardScraper again.");
  try {
    const r = await api.tabs.sendMessage(tab.id, msg);
    if (r !== undefined) return r;
  } catch {}
  // Content script missing (tab opened before access was granted): inject it.
  let injectErr = null;
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js", "batch.js", "chats-batch.js"] });
  } catch (e) {
    injectErr = e;
  }
  try {
    const r = await api.tabs.sendMessage(tab.id, msg);
    if (r !== undefined) return r;
  } catch (e) {
    injectErr ||= e;
  }
  const why = String(injectErr?.message || injectErr || "no response");
  const hint = !tab.url
    ? "Safari hasn't given CardScraper access to this site. Tap the ᴀA button → CardScraper → Allow, then reload the page."
    : tab.incognito
      ? "In private tabs Safari also needs the per-site permission: tap ᴀA → CardScraper → Allow, then reload the page."
      : "Reload the page and try again.";
  throw new Error(`Can't reach the page (${describe(tab)}): ${why}. ${hint}`);
}
