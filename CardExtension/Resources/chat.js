// Chat tab: scrape the conversation on the page and export it as a
// SillyTavern chat (.jsonl): one header line, then one line per message.
//
// Every message carries its own speaker (read from that message's name
// label or avatar). The user decides which speaker is the character and
// which is them; nothing is inferred from message order.

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const chat = {
  messages: [],     // { md, plain, speaker: string|null, is_user: bool|null }
  roles: new Map(), // speaker -> "char" | "user"
  url: "",
  loaded: false,
  busy: false,
};

function pad(n) { return String(n).padStart(2, "0"); }

// SillyTavern's own date formats.
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
      name: m.name,
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

const speakers = () => [...chat.roles.keys()];
const speakersWithRole = (role) => speakers().filter((s) => chat.roles.get(s) === role);

function isUser(m) {
  return m.speaker ? chat.roles.get(m.speaker) === "user" : m.is_user;
}

function names() {
  return { charName: $("chatChar").value.trim() || "Character", userName: $("chatUser").value.trim() || "You" };
}

// Name written into the file for one message.
function nameFor(m) {
  const { charName, userName } = names();
  const u = isUser(m);
  const sameSide = speakersWithRole(u ? "user" : "char");
  // Several characters (or personas) on one side: keep each one's own name.
  if (m.speaker && sameSide.length > 1) return m.speaker;
  return u ? userName : charName;
}

function textOf(m) { return $("chatMd").checked ? m.md : m.plain; }

function syncNameInputs() {
  const c = speakersWithRole("char")[0];
  const u = speakersWithRole("user")[0];
  if (c && !$("chatChar").dataset.touched) $("chatChar").value = c;
  if (u && !$("chatUser").dataset.touched) $("chatUser").value = u;
}

function renderSpeakers() {
  const box = $("speakers");
  box.textContent = "";
  box.hidden = !chat.roles.size;
  for (const sp of speakers()) {
    const n = chat.messages.filter((m) => m.speaker === sp).length;
    const row = document.createElement("div");
    row.className = "speaker";
    const label = document.createElement("span");
    label.className = "sp-name";
    label.textContent = `${sp} · ${n}`;
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [role, text] of [["char", "Character"], ["user", "You"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.classList.toggle("on", chat.roles.get(sp) === role);
      b.addEventListener("click", () => {
        chat.roles.set(sp, role);
        syncNameInputs();
        render();
      });
      seg.append(b);
    }
    row.append(label, seg);
    box.append(row);
  }
}

function render() {
  renderSpeakers();
  const list = $("chatList");
  list.textContent = "";
  chat.messages.forEach((m, i) => {
    const u = isUser(m);
    const li = document.createElement("li");
    li.className = "msg " + (u == null ? "unknown" : u ? "user" : "char");

    const who = document.createElement("button");
    who.type = "button";
    who.className = "who";
    who.textContent = u == null ? "? set speaker" : m.speaker || nameFor(m);
    who.title = "Tap to change who wrote this";
    who.addEventListener("click", () => {
      const sps = speakers();
      if (sps.length) {
        // Cycle through the real speakers.
        const k = sps.indexOf(m.speaker);
        m.speaker = sps[(k + 1) % sps.length];
      } else {
        m.is_user = m.is_user == null ? false : !m.is_user;
      }
      render();
    });

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
  const unknown = chat.messages.filter((m) => isUser(m) == null).length;
  const users = chat.messages.filter((m) => isUser(m) === true).length;
  $("chatCount").textContent = n ? `${n} messages · ${n - users - unknown} character · ${users} you${unknown ? ` · ${unknown} unknown` : ""}` : "";
  $("saveChat").disabled = !n || unknown > 0;
  if (unknown) setStatus(`${unknown} message${unknown > 1 ? "s have" : " has"} no speaker. Tap “? set speaker” on ${unknown > 1 ? "them" : "it"}.`, true);
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
    chat.roles = new Map();
    // Default: the most active non-character speaker is you; extra speakers
    // (narrators, NPCs) default to the character side. Changeable in the list.
    const count = (sp) => chat.messages.filter((m) => m.speaker === sp).length;
    const others = (res.speakers || []).filter((sp) => sp !== res.charSpeaker).sort((a, b) => count(b) - count(a));
    for (const sp of res.speakers || []) chat.roles.set(sp, sp === others[0] ? "user" : "char");
    if (!$("chatChar").dataset.touched) $("chatChar").value = res.charSpeaker || res.charName || "";
    if (!$("chatUser").dataset.touched) $("chatUser").value = "You";
    syncNameInputs();
    chat.loaded = true;
    setStatus("");
    render();
    if (!chat.messages.length) {
      setStatus("No messages found. Open the chat itself, then try again.", true);
    } else if (!$("status").textContent) {
      setStatus(`Found ${chat.messages.length} messages, speakers read from ${res.method}. ` +
        (chat.roles.size ? "Pick who's the character and who's you above." : "Tap a chip to fix any message."));
    }
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    chat.busy = false;
    $("rescanChat").disabled = false;
    const unknown = chat.messages.filter((m) => isUser(m) == null).length;
    $("saveChat").disabled = !chat.messages.length || unknown > 0;
  }
}

export function chatFile() {
  const { charName, userName } = names();
  const jsonl = buildJsonl({
    charName,
    userName,
    messages: chat.messages.map((m) => ({ is_user: isUser(m), name: nameFor(m), text: textOf(m) })),
  });
  const safe = charName.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 60);
  return new File([jsonl], `${safe} - ${stCreateDate()}.jsonl`, { type: "application/jsonl" });
}

export function chatLoaded() { return chat.loaded; }

export async function debugFile() {
  const res = await send({ type: "chatDebug" });
  return new File([res?.text || "no response"], "cardscraper-debug.txt", { type: "text/plain" });
}

export function initChat() {
  for (const id of ["chatChar", "chatUser"]) {
    $(id).addEventListener("input", (e) => { e.target.dataset.touched = "1"; render(); });
  }
  $("chatMd").addEventListener("change", render);
  $("rescanChat").addEventListener("click", loadChat);
}
