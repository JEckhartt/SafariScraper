// Chat tab: scrape the conversation on the page and export it as a
// SillyTavern chat (.jsonl): one header line, then one line per message.

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const chat = { messages: [], url: "", loaded: false, busy: false };

function pad(n) { return String(n).padStart(2, "0"); }

// SillyTavern's own formats.
function stCreateDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`;
}
function stSendDate(d) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h}:${pad(d.getMinutes())}${ampm}`;
}

export function buildJsonl({ charName, userName, messages }) {
  const now = new Date();
  const start = new Date(now.getTime() - messages.length * 60_000);
  const lines = [
    JSON.stringify({ user_name: userName, character_name: charName, create_date: stCreateDate(now), chat_metadata: {} }),
  ];
  messages.forEach((m, i) => {
    lines.push(JSON.stringify({
      name: m.is_user ? userName : charName,
      is_user: !!m.is_user,
      is_system: false,
      send_date: stSendDate(new Date(start.getTime() + i * 60_000)),
      mes: m.text,
      extra: {},
    }));
  });
  return lines.join("\n") + "\n";
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function names() {
  return { charName: $("chatChar").value.trim() || "Character", userName: $("chatUser").value.trim() || "You" };
}

function textOf(m) { return $("chatMd").checked ? m.md : m.plain; }

function render() {
  const list = $("chatList");
  list.textContent = "";
  const { charName, userName } = names();
  chat.messages.forEach((m, i) => {
    const li = document.createElement("li");
    li.className = m.is_user ? "msg user" : "msg char";

    const who = document.createElement("button");
    who.type = "button";
    who.className = "who";
    who.textContent = m.is_user ? userName : charName;
    who.title = "Tap to switch speaker";
    who.addEventListener("click", () => { m.is_user = !m.is_user; render(); });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.title = "Remove this message";
    del.addEventListener("click", () => { chat.messages.splice(i, 1); render(); });

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = textOf(m);
    body.addEventListener("click", () => body.classList.toggle("open"));

    const head = document.createElement("div");
    head.className = "head";
    head.append(who, del);
    li.append(head, body);
    list.append(li);
  });
  const n = chat.messages.length;
  const u = chat.messages.filter((m) => m.is_user).length;
  $("chatCount").textContent = n ? `${n} messages · ${n - u} ${charName} · ${u} ${userName}` : "";
  $("saveChat").disabled = !n;
}

async function send(msg) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try {
    return await api.tabs.sendMessage(tab.id, msg);
  } catch {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return api.tabs.sendMessage(tab.id, msg);
  }
}

export async function probeChat() {
  try { return (await send({ type: "chatProbe" }))?.chat; } catch { return false; }
}

export async function loadChat() {
  if (chat.busy) return;
  chat.busy = true;
  $("rescanChat").disabled = $("saveChat").disabled = true;
  const loadAll = $("chatLoadAll").checked;
  setStatus(loadAll ? "Scrolling up to load the whole chat… (long chats take a while)" : "Reading messages…");
  try {
    const res = await send({ type: "chat", loadAll });
    if (!res || res.error) throw new Error(res?.error || "No response from page.");
    chat.url = res.url;
    chat.messages = res.messages.map((m) => ({ ...m }));
    if (!$("chatChar").dataset.touched) $("chatChar").value = res.charName || "";
    if (!$("chatUser").dataset.touched) $("chatUser").value = res.userName || "You";
    chat.loaded = true;
    render();
    setStatus(chat.messages.length
      ? `Found ${chat.messages.length} messages. Speakers by ${res.method}. Tap a name to flip it, ✕ to drop junk.`
      : "No messages found. Open the chat itself, then try again.", !chat.messages.length);
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    chat.busy = false;
    $("rescanChat").disabled = false;
    $("saveChat").disabled = !chat.messages.length;
  }
}

export function chatFile() {
  const { charName, userName } = names();
  const jsonl = buildJsonl({
    charName,
    userName,
    messages: chat.messages.map((m) => ({ is_user: m.is_user, text: textOf(m) })),
  });
  const safe = charName.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 60);
  return new File([jsonl], `${safe} - ${stCreateDate()}.jsonl`, { type: "application/jsonl" });
}

export function chatLoaded() { return chat.loaded; }

export function initChat() {
  for (const id of ["chatChar", "chatUser"]) {
    $(id).addEventListener("input", (e) => { e.target.dataset.touched = "1"; render(); });
  }
  $("chatMd").addEventListener("change", render);
  $("rescanChat").addEventListener("click", loadChat);
}
