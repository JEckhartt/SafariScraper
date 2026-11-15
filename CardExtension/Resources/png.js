// Tavern / SillyTavern character card writer: a PNG with the card JSON
// base64-encoded in a tEXt chunk keyed "chara" (V2 spec, V1 fields mirrored).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
export const isPng = (b) => PNG_SIG.every((v, i) => b[i] === v);

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function textChunk(keyword, text) {
  const k = new TextEncoder().encode(keyword);
  const t = new TextEncoder().encode(text); // base64 → plain ASCII anyway
  const data = new Uint8Array(k.length + 1 + t.length);
  data.set(k, 0);
  data.set(t, k.length + 1);
  return chunk("tEXt", data);
}

// Remove any existing chara/ccv3 tEXt chunks, then insert ours right before IEND.
export function embedCard(pngBytes, card) {
  if (!isPng(pngBytes)) throw new Error("Not a PNG");
  const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  const keep = [pngBytes.subarray(0, 8)];
  let off = 8, iend = null;
  while (off + 12 <= pngBytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...pngBytes.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    const whole = pngBytes.subarray(off, end);
    if (type === "IEND") { iend = whole; break; }
    let drop = false;
    if (type === "tEXt") {
      const data = pngBytes.subarray(off + 8, off + 8 + len);
      const z = data.indexOf(0);
      const key = String.fromCharCode(...data.subarray(0, z < 0 ? 0 : z)).toLowerCase();
      drop = key === "chara" || key === "ccv3";
    }
    if (!drop) keep.push(whole);
    off = end;
  }
  if (!iend) throw new Error("Corrupt PNG (no IEND)");

  const json = new TextEncoder().encode(JSON.stringify(card));
  keep.push(textChunk("chara", base64(json)), iend);

  const total = keep.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of keep) { out.set(part, p); p += part.length; }
  return out;
}

export function buildCard({ name, description, personality, scenario, first_mes, mes_example, creator_notes, source }) {
  const data = {
    name: name || "Character",
    description: description || "",
    personality: personality || "",
    scenario: scenario || "",
    first_mes: first_mes || "",
    mes_example: mes_example || "",
    creator_notes: creator_notes || "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "",
    character_version: "",
    extensions: source ? { source_url: source } : {},
  };
  return {
    // V1 fields at the top level for older importers.
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    spec: "chara_card_v2",
    spec_version: "2.0",
    data,
  };
}
