// Relays popup requests to the native app extension (which saves to Photos).
const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "native") return;
  api.runtime
    .sendNativeMessage("application.id", msg.payload)
    .then((res) => sendResponse({ ok: true, res }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});
