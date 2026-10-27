// API de la biblioteca compartida de ejercicios de MonasFIT SALUD.
//
//  Alumnado (cabecera x-mf-a = código de acceso en forma de hash):
//    GET  /api/ejercicios            -> ejercicios publicados (sin fotos)
//    GET  /api/ejercicios?img=ID     -> foto de un ejercicio publicado
//    POST /api/ejercicios            -> propone un ejercicio (queda PENDIENTE)
//  Profesor (cabecera x-mf-t = variable de entorno ADMIN_CODE):
//    POST /api/admin {action:"list"|"approve"|"delete", id}
//
// Los ejercicios nuevos nunca se muestran al alumnado hasta que el profesor los publica.

import { getStore } from "@netlify/blobs";

const ORIGINS = ["https://monasfit.netlify.app"];
const MAX_PENDING = 40;
const MAX_APPROVED = 400;
const MAX_IMG = 100000; // bytes
const LOCK_MAX = 8;
const LOCK_MS = 15 * 60 * 1000;

const store = () => getStore({ name: "ejercicios", consistency: "strong" });
const studentHash = () => Netlify.env.get("STUDENT_HASH") || "5683055764724731";

function cors(req) {
  const o = req.headers.get("origin") || "";
  const extra = (Netlify.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim());
  const ok = ORIGINS.includes(o) || extra.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "access-control-allow-origin": ok ? o : ORIGINS[0],
    "access-control-allow-headers": "content-type,x-mf-a,x-mf-t",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}
function json(req, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors(req) },
  });
}
const err = (req, status, msg) => json(req, { ok: false, error: msg }, status);

function same(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const txt = (v, n) =>
  String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

function clean(b) {
  if (!b || typeof b !== "object") return null;
  const n = txt(b.n, 80);
  if (!n) return null;
  const ins = Array.isArray(b.ins) ? b.ins.map((t) => txt(t, 300)).filter(Boolean).slice(0, 30) : [];
  const g = Number.isInteger(b.g) && b.g >= 0 && b.g < 40 ? b.g : 0;
  const l = Number.isInteger(b.l) && b.l >= 0 && b.l <= 2 ? b.l : 0;
  const m = /^[A-Z]{1,2}$/.test(String(b.m)) ? String(b.m) : "O";
  return { n, v: txt(b.v, 80), g, m, l, ins: ins.length ? ins : null };
}

function parseImg(s) {
  if (!s) return null;
  const mt = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(s));
  if (!mt) return false;
  const buf = Buffer.from(mt[1], "base64");
  if (buf.length < 100 || buf.length > MAX_IMG) return false;
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return false;
  return buf;
}

const newId = () => Number(String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0"));
const okId = (v) => (/^\d{10,17}$/.test(String(v)) ? String(v) : null);

async function adminOk(req, st) {
  const code = Netlify.env.get("ADMIN_CODE");
  if (!code) return { err: err(req, 503, "Falta configurar ADMIN_CODE en Netlify.") };
  const now = Date.now();
  let lock = (await st.get("lock", { type: "json" })) || { fails: 0, since: now };
  if (now - lock.since > LOCK_MS) lock = { fails: 0, since: now };
  if (lock.fails >= LOCK_MAX) return { err: err(req, 429, "Demasiados intentos. Espera unos 15 minutos.") };
  if (!same(req.headers.get("x-mf-t"), code)) {
    lock.fails++;
    await st.setJSON("lock", lock);
    return { err: err(req, 401, "Código del profesor incorrecto.") };
  }
  if (lock.fails) await st.setJSON("lock", { fails: 0, since: now });
  return { ok: true };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const url = new URL(req.url);
  const st = store();
  try {
    /* ---------- Profesor ---------- */
    if (url.pathname.endsWith("/admin")) {
      if (req.method !== "POST") return err(req, 405, "Método no permitido.");
      const a = await adminOk(req, st);
      if (a.err) return a.err;
      let b;
      try { b = await req.json(); } catch { return err(req, 400, "Petición no válida."); }
      const action = b && b.action;
      if (action === "list") {
        const { blobs } = await st.list({ prefix: "p/" });
        const pending = [];
        for (const k of blobs) {
          const meta = await st.get(k.key, { type: "json" });
          if (!meta) continue;
          const buf = await st.get("i/" + meta.id, { type: "arrayBuffer" });
          pending.push({ ...meta, img: buf ? "data:image/jpeg;base64," + Buffer.from(buf).toString("base64") : "" });
        }
        pending.sort((x, y) => x.t - y.t);
        const approved = (await st.get("idx", { type: "json" })) || [];
        return json(req, { ok: true, pending, approved });
      }
      const id = okId(b && b.id);
      if (!id) return err(req, 400, "Identificador no válido.");
      if (action === "approve") {
        const meta = await st.get("p/" + id, { type: "json" });
        if (!meta) return err(req, 404, "Ese ejercicio ya no está pendiente.");
        const idx = (await st.get("idx", { type: "json" })) || [];
        if (idx.length >= MAX_APPROVED) return err(req, 409, "Se ha alcanzado el máximo de ejercicios publicados.");
        if (!idx.some((x) => String(x.id) === id)) idx.push(meta);
        await st.setJSON("idx", idx);
        await st.delete("p/" + id);
        return json(req, { ok: true });
      }
      if (action === "delete") {
        const idx = (await st.get("idx", { type: "json" })) || [];
        if (idx.some((x) => String(x.id) === id)) await st.setJSON("idx", idx.filter((x) => String(x.id) !== id));
        await st.delete("p/" + id);
        await st.delete("i/" + id);
        return json(req, { ok: true });
      }
      return err(req, 400, "Acción no válida.");
    }

    /* ---------- Alumnado ---------- */
    if (!same(req.headers.get("x-mf-a"), studentHash())) return err(req, 401, "Código de acceso no válido.");

    if (req.method === "GET") {
      const idq = url.searchParams.get("img");
      if (idq) {
        const id = okId(idq);
        const idx = (await st.get("idx", { type: "json" })) || [];
        if (!id || !idx.some((x) => String(x.id) === id)) return err(req, 404, "No encontrado.");
        const buf = await st.get("i/" + id, { type: "arrayBuffer" });
        if (!buf) return err(req, 404, "No encontrado.");
        return new Response(buf, {
          headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400", ...cors(req) },
        });
      }
      const idx = (await st.get("idx", { type: "json" })) || [];
      return json(req, { ok: true, items: idx });
    }

    if (req.method === "POST") {
      const len = Number(req.headers.get("content-length") || 0);
      if (len > 400000) return err(req, 413, "La imagen es demasiado grande.");
      let b;
      try { b = await req.json(); } catch { return err(req, 400, "Petición no válida."); }
      const meta = clean(b);
      if (!meta) return err(req, 400, "Falta el nombre del ejercicio.");
      const buf = parseImg(b.img);
      if (buf === false) return err(req, 400, "La foto no es válida o es demasiado grande.");
      const { blobs } = await st.list({ prefix: "p/" });
      if (blobs.length >= MAX_PENDING)
        return err(req, 429, "Hay demasiados ejercicios pendientes de revisar. Avisa a tu profesor.");
      const id = newId();
      if (buf) await st.set("i/" + id, buf, { metadata: { type: "image/jpeg" } });
      await st.setJSON("p/" + id, { id, ...meta, hi: buf ? 1 : 0, t: Date.now() });
      return json(req, { ok: true, id });
    }
    return err(req, 405, "Método no permitido.");
  } catch (e) {
    console.error(e);
    return err(req, 500, "Error del servidor.");
  }
};

export const config = { path: ["/api/ejercicios", "/api/admin"] };
