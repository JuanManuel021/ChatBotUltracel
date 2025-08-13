// index.js
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cheerio = require("cheerio");
const { google } = require("googleapis");
require("dotenv").config();

/* ====================  CONFIG  ==================== */
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const MODEL_FALLBACK = process.env.GEMINI_MODEL_FALLBACK || "gemini-1.5-pro";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ULTRACEL_URL = process.env.ULTRACEL_URL || "https://ultracel.com.mx/";
const SCRAPE_TTL_MS = 6 * 60 * 60 * 1000;       // 6h cache del sitio
const COMPANY_TEXT_TTL_MS = 2 * 60 * 60 * 1000; // 2h cache del texto generado

// Admin y Recargas
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "527779313920"; // sin '+'
const ALLOWED_AMOUNTS = [110, 160, 210];

// Calendar (.env que ya tienes)
const TIMEZONE = process.env.TIMEZONE || "America/Mexico_City";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";

/* ================  FETCH COMPAT  =================== */
async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch;
}

/* ====================  GEMINI  ===================== */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
function getModel(name) {
  return genAI.getGenerativeModel({ model: name });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function backoffMs(attempt) {
  const base = 500 * Math.pow(2, attempt);
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(250, Math.floor(base + jitter));
}
async function generateWithGemini(content, { tries = 4 } = {}) {
  let lastErr;
  let modelName = MODEL_PRIMARY;
  for (let i = 0; i < tries; i++) {
    try {
      const model = getModel(modelName);
      const res = await model.generateContent(content);
      const text = res?.response?.text?.();
      if (text && text.trim()) return text.trim();
      throw new Error("Respuesta vacía del modelo");
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isOverloaded = /503|overloaded|temporarily|unavailable/i.test(msg);
      const isRate = /429|rate|quota/i.test(msg);
      const retriable = isOverloaded || isRate || /ECONNRESET|ETIMEDOUT|fetch/i.test(msg);
      if (i === 1) modelName = MODEL_FALLBACK;
      if (retriable && i < tries - 1) {
        await delay(backoffMs(i));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/* ==========  WHATSAPP CLIENT  ========== */
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "bot-gemini" }),
});

/* ==========  SESIONES EN MEMORIA  ========== */
const sessions = new Map(); // chatId -> { state, data, last }
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() });
  const s = sessions.get(chatId);
  s.last = Date.now();
  return s;
}
function setState(chatId, state, patch = {}) {
  const s = getSession(chatId);
  s.state = state;
  s.data = { ...s.data, ...patch };
}
function reset(chatId) {
  sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() });
}

/* ==========  UTILS TEXTO  ========== */
const isGreeting = (text) =>
  !!text && /\b(hola|buenos dias|buenas|buenas tardes|buenas noches)\b/i.test(text.trim());
const isCancel = (text) =>
  !!text && ["cancelar", "menu", "salir", "inicio"].includes(text.toLowerCase().trim());
const onlyDigits = (s) => (s || "").replace(/\D/g, "");
const isMxPhone = (s) => /^\d{10}$/.test(onlyDigits(s));
const isPortabilityInterest = (text) => {
  if (!text) return false;
  const t = text.toLowerCase();
  return /(me interesa|quiero cambiarme|quiero cambiar|cambiarme|qué necesito|que necesito|necesito cambiar|quiero portar|portabilidad)/i.test(t);
};
const isYes = (t) => /\b(si|sí|correcto|confirmo|ok|de acuerdo|así es|vale)\b/i.test((t||"").trim());
const isNo  = (t) => /\b(no|negativo|cambiar|no es|otra|equivocado)\b/i.test((t||"").trim());

/* ==========  MENSAJES  ========== */
const PORTABILITY_REQUIREMENTS =
  "🙌 *Excelente, te ayudamos con tu cambio a Ultracel.*\n\n" +
  "Para continuar, por favor compárteme:\n" +
  "• *IMEI* del teléfono (marca *#06#* para verlo).\n" +
  "• *Nombre completo* del titular.\n" +
  "• *Correo electrónico* de contacto.\n" +
  "• *NIP de portabilidad*: envía un SMS al *051* con la palabra *NIP* o llama al *051*.\n\n" +
  "Cuando tengas estos datos, envíalos en un solo mensaje o en mensajes separados.";

const CALL_CENTER_MSG =
  "CALL CENTER\n" +
  "Horarios de Atención\n" +
  "Lunes a Viernes 8:30 am a 8:00 pm\n" +
  "Sábado 9:00 am a 7:00 pm\n" +
  "Domingo 10:00 am a  3:00 pm\n" +
  "Días festivos \n" +
  "Línea: 5589202828\n" +
  "Whats: 5629661624\n\n" +
  "Los horarios de call center es para UF (Usuario Final) o bien ustedes pueden marcar en apoyo al UF siempre y cuando esté presencial con ustedes";

const WELCOME_MENU =
  "Muchas gracias por ponerte en contacto con *Ultracel*.\n" +
  "¿En qué puedo apoyarte hoy?\n\n" +
  "1. Información sobre la compañía\n" +
  "2. Recargas\n" +
  "3. Problemas con servicio\n" +
  "4. Agendar una cita\n" +
  "5. Hablar con una persona\n\n" +
  "_Escribe el número de la opción, o `cancelar` para volver aquí._";

/* ==========  SCRAPER: ULTRACEL (cache)  ========== */
let siteCache = { text: "", at: 0 };
async function scrapeUltracelText() {
  const now = Date.now();
  if (siteCache.text && now - siteCache.at < SCRAPE_TTL_MS) return siteCache.text;
  const _fetch = await getFetch();
  const res = await _fetch(ULTRACEL_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} al obtener ${ULTRACEL_URL}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  ["script", "style", "noscript", "svg"].forEach((sel) => $(sel).remove());
  const mainText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  siteCache = { text: mainText, at: now };
  return mainText;
}

/* ==========  TEXTO INFO (Gemini + cache)  ========== */
let companyInfoCache = { text: "", at: 0 };
async function buildCompanyInfoWithGemini() {
  const now = Date.now();
  if (companyInfoCache.text && now - companyInfoCache.at < COMPANY_TEXT_TTL_MS) {
    return companyInfoCache.text;
  }
  try {
    const siteText = await scrapeUltracelText();
    const prompt =
      `=== TEXTO DEL SITIO (recortado) ===\n${siteText}\n=== FIN ===\n\n` +
      "Eres asesor de Ultracel. Usa SOLO lo que veas arriba. Redacta un mensaje cálido (8–10 líneas) sobre beneficios de *cambiarse a Ultracel* (planes, cobertura, facilidad). Invita a seguir con preguntas (paquetes, cobertura, cómo contratar). Evita inventar.";
    const out = await generateWithGemini(prompt, { tries: 4 });
    const text = out.length > 4000 ? out.slice(0, 4000) + "…" : out;
    companyInfoCache = { text, at: now };
    return text;
  } catch (err) {
    const fallback =
      "📘 *Información sobre Ultracel*\n\n" +
      "Gracias por tu interés en cambiarte con nosotros. Contamos con cobertura nacional y opciones de prepago. " +
      "Puedo ayudarte a revisar *paquetes*, *cobertura* y *cómo contratar*. ¿Qué te gustaría saber primero?";
    companyInfoCache = { text: fallback, at: now };
    return fallback;
  }
}

/* ==========  MEDIA LOCAL (Opción 1)  ========== */
function getCompanyImageMedia() {
  const imgPath = path.resolve(__dirname, "assets/ultracel-info.jpg");
  return MessageMedia.fromFilePath(imgPath);
}

/* ==========  AVISOS AL ADMIN  ========== */
async function sendToAdmin(messageText) {
  try {
    const numberId = await client.getNumberId(ADMIN_NUMBER);
    if (!numberId) {
      console.error(`❌ getNumberId no resolvió ${ADMIN_NUMBER}. ¿Tiene WhatsApp y chat iniciado?`);
      return false;
    }
    const chatId = numberId._serialized;
    await client.sendMessage(chatId, messageText);
    console.log(`✅ Aviso enviado al admin (${chatId}).`);
    return true;
  } catch (e) {
    console.error("❌ Error enviando mensaje al admin:", e?.message || e);
    return false;
  }
}

/* ======== Utilidades de fecha con zona horaria ======== */
function todayInTZ(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = f.formatToParts(new Date());
  const y = parts.find(p => p.type==='year')?.value || '1970';
  const m = parts.find(p => p.type==='month')?.value || '01';
  const d = parts.find(p => p.type==='day')?.value || '01';
  return new Date(`${y}-${m}-${d}T00:00:00`);
}
function addDays(date, days){ const d=new Date(date); d.setDate(d.getDate()+days); return d; }
function toISODateLocal(date){
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
const WEEKDAYS = { 'domingo':0,'lunes':1,'martes':2,'miércoles':3,'miercoles':3,'jueves':4,'viernes':5,'sábado':6,'sabado':6 };
const MONTHS = { 'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,'julio':7,'agosto':8,'septiembre':9,'setiembre':9,'octubre':10,'noviembre':11,'diciembre':12 };

/* ======== Parser de fecha “reglas primero”, Gemini como fallback ======== */
async function parseDateSmart(input) {
  const txt = (input||'').toLowerCase().trim();
  const base = todayInTZ(TIMEZONE);

  // 1) Relativos comunes
  if (/\b(hoy)\b/.test(txt)) {
    return { isoDate: toISODateLocal(base), readable: 'hoy' };
  }
  if (/\b(pasado\s+mañana|pasado\s+manana)\b/.test(txt)) {
    const d = addDays(base, 2);
    return { isoDate: toISODateLocal(d), readable: 'pasado mañana' };
  }
  if (/\b(mañana|manana)\b/.test(txt)) {
    const d = addDays(base, 1);
    return { isoDate: toISODateLocal(d), readable: 'mañana' };
  }

  // 2) “próximo/este <día>”
  const mDia = txt.match(/\b(próximo|proximo|este|esta)\s+(domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/);
  if (mDia) {
    const wd = WEEKDAYS[mDia[2]];
    const todayWD = base.getDay();
    let delta = (wd - todayWD + 7) % 7;
    if (delta === 0 || mDia[1].startsWith('próximo') || mDia[1].startsWith('proximo')) delta = (delta===0?7:delta);
    const d = addDays(base, delta);
    return { isoDate: toISODateLocal(d), readable: `${mDia[1]} ${mDia[2]}` };
  }

  // 3) dd/mm[/yyyy]  ó  dd-mm[-yyyy]
  let m = txt.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?\b/);
  if (m) {
    let [_, dd, mm, yyyy] = m;
    dd = parseInt(dd,10); mm = parseInt(mm,10); yyyy = yyyy?parseInt(yyyy,10):base.getFullYear();
    const candidate = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`);
    const candidateISO = toISODateLocal(candidate);
    const baseISO = toISODateLocal(base);
    const inPast = new Date(candidateISO) < new Date(baseISO);
    const finalDate = (!m[3] && inPast) ? new Date(`${yyyy+1}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`) : candidate;
    return { isoDate: toISODateLocal(finalDate), readable: `${dd}/${mm}${m[3]?`/${yyyy}`:''}` };
  }

  // 4) “17 de agosto [de 2025]”
  m = txt.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/);
  if (m) {
    let dd = parseInt(m[1],10);
    let mm = MONTHS[m[2]];
    let yyyy = m[3] ? parseInt(m[3],10) : base.getFullYear();
    let candidate = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`);
    if (!m[3] && candidate < base) candidate = new Date(`${yyyy+1}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`);
    return { isoDate: toISODateLocal(candidate), readable: `${dd} de ${m[2]}${m[3]?` de ${yyyy}`:''}` };
  }

  // 5) Fallback a Gemini (pero validamos que no devuelva pasado)
  try {
    const g = await parseDateWithGemini(input);
    if (g && g.isoDate) {
      const parsed = new Date(`${g.isoDate}T00:00:00`);
      if (parsed < base) {
        const tomorrow = addDays(base,1);
        return { isoDate: toISODateLocal(tomorrow), readable: 'mañana' };
      }
      return g;
    }
  } catch {}
  return { isoDate: null, readable: null };
}

/* ======== Parser de hora: reglas primero + Gemini fallback ======== */
function toTwo(n){ return String(n).padStart(2,'0'); }

function parseTimeByRules(input) {
  if (!input) return { isoTime: null, readable: null };
  const t = input.toLowerCase().trim()
    .replace(/\s+/g,' ')
    .replace(/[\.]/g,'');

  // expresiones directas
  if (/\b(medio ?d[ií]a|mediod[ií]a)\b/.test(t)) return { isoTime: "12:00", readable: "mediodía" };
  if (/\b(media ?noche|medianoche)\b/.test(t))   return { isoTime: "00:00", readable: "medianoche" };

  // hh[:mm] [am|pm]
  let m = t.match(/\b(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\b/);
  if (m) {
    let h = parseInt(m[1],10); let mm = parseInt(m[2] ?? "0",10);
    const suf = m[3];
    if (h === 12 && suf === 'am') h = 0;        // 12am -> 00
    else if (h !== 12 && suf === 'pm') h += 12; // 1pm..11pm -> 13..23
    if (h>23 || mm>59) return { isoTime:null, readable:null };
    return { isoTime: `${toTwo(h)}:${toTwo(mm)}`, readable: `${toTwo(h)}:${toTwo(mm)}` };
  }

  // hh:mm (24h)
  m = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    let h = parseInt(m[1],10); let mm = parseInt(m[2],10);
    if (h>23 || mm>59) return { isoTime:null, readable:null };
    return { isoTime: `${toTwo(h)}:${toTwo(mm)}`, readable: `${toTwo(h)}:${toTwo(mm)}` };
  }

  // solo hora (1..23). Heurística: si 1..11 y no dice am/pm, asumimos pm
  m = t.match(/\b(\d{1,2})\b/);
  if (m) {
    let h = parseInt(m[1],10);
    if (h>=0 && h<=23) {
      if (h>=1 && h<=11) h += 12; // asumir tarde por defecto
      return { isoTime: `${toTwo(h)}:00`, readable: `${toTwo(h)}:00` };
    }
  }

  return { isoTime: null, readable: null };
}

async function parseTimeSmart(input) {
  // 1) Reglas
  const r = parseTimeByRules(input);
  if (r.isoTime) return r;

  // 2) Fallback a Gemini
  try {
    const g = await parseTimeWithGemini(input);
    if (g && g.isoTime) return g;
  } catch {}
  return { isoTime: null, readable: null };
}

/* ==========  GOOGLE CALENDAR (con refresh token)  ========== */
function getCalendarClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltan GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN en .env");
  }
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: "v3", auth: oAuth2Client });
}

async function isSlotFree(startISO, endISO) {
  const calendar = getCalendarClient();
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: TIMEZONE,
      items: [{ id: GOOGLE_CALENDAR_ID }],
    },
  });
  const busy = res.data.calendars[GOOGLE_CALENDAR_ID]?.busy || [];
  return busy.length === 0;
}

async function createCalendarEvent({ summary, description, startISO, endISO }) {
  const calendar = getCalendarClient();
  const event = {
    summary,
    description,
    start: { dateTime: startISO, timeZone: TIMEZONE },
    end:   { dateTime: endISO,   timeZone: TIMEZONE },
  };
  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
  });
  return res.data;
}

/* ==========  PARSE NATURAL (fecha/hora) con Gemini  ========== */
async function parseDateWithGemini(input) {
  const prompt =
    `Interpreta una FECHA en español y responde SOLO JSON.\n` +
    `Zona horaria: ${TIMEZONE}.\n` +
    `Entrada: """${input}"""\n` +
    `Devuelve: {"isoDate":"YYYY-MM-DD","readable":"<humanizado>"} o {"isoDate":null,"readable":null}.`;
  const out = await generateWithGemini(prompt, { tries: 3 });
  try {
    const json = JSON.parse(out.replace(/```json|```/g, "").trim());
    return json;
  } catch {
    return { isoDate: null, readable: null };
  }
}
async function parseTimeWithGemini(input) {
  const prompt =
    `Interpreta una HORA en español y responde SOLO JSON (24h).\n` +
    `Ejemplos: "3 pm"->{"isoTime":"15:00"}, "15:30"->{"isoTime":"15:30"}, "mediodía"->{"isoTime":"12:00"}, "medianoche"->{"isoTime":"00:00"}.\n` +
    `Entrada: """${input}"""\n` +
    `Devuelve: {"isoTime":"HH:MM","readable":"<humanizado>"} o {"isoTime":null,"readable":null}.`;
  const out = await generateWithGemini(prompt, { tries: 3 });
  try {
    const json = JSON.parse(out.replace(/```json|```/g, "").trim());
    return json;
  } catch {
    return { isoTime: null, readable: null };
  }
}

/* ==================  EVENTOS WPP  ==================== */
client.on("qr", (qr) => {
  require("qrcode-terminal").generate(qr, { small: true });
});
client.on("ready", () => console.log("Bot listo con Gemini! ✅"));
client.on("authenticated", () => console.log("✅ Autenticado"));
client.on("auth_failure", (m) => console.error("❌ Fallo de auth:", m));
client.on("disconnected", (r) => console.error("🔌 Desconectado:", r));

/* ==================  HANDLER MSG  ==================== */
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const text = (msg.body || "").trim();

    // Comando libre: gemini ...
    if (text.toLowerCase().startsWith("gemini")) {
      try {
        const out = await generateWithGemini(text.slice(6).trim() || "Hola, ¿en qué te ayudo?");
        await msg.reply(out.length > 4000 ? out.slice(0, 4000) + "…" : out);
      } catch (e) {
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }

    // Globales
    if (isCancel(text) || isGreeting(text)) {
      reset(chatId);
      await msg.reply(WELCOME_MENU);
      return;
    }

    // Interés de portabilidad (mensaje libre)
    if (isPortabilityInterest(text)) {
      setState(chatId, "CAMBIO_DATOS");
      await msg.reply(PORTABILITY_REQUIREMENTS);
      return;
    }

    // Flujo por estado
    const session = getSession(chatId);

    switch (session.state) {
      case "IDLE": {
        if (/^[1-5]$/.test(text)) {
          const n = text;

          // Opción 1: Info compañía
          if (n === "1") {
            const infoText = await buildCompanyInfoWithGemini();
            try {
              const media = getCompanyImageMedia();
              await client.sendMessage(chatId, media, { caption: infoText });
            } catch {
              await msg.reply(infoText);
            }
            setState(chatId, "INFO_COMPANIA");
            return;
          }

          // Opción 2: Recargas
          if (n === "2") {
            await msg.reply(
              "💳 *Recargas*\nPaso 1/2: Envíame el *número a recargar* (10 dígitos). Ejemplo: 7771234567\n_Escribe `cancelar` para volver al menú._"
            );
            setState(chatId, "RECARGA_NUMERO");
            return;
          }

          // Opción 3: Call center
          if (n === "3") {
            await msg.reply(CALL_CENTER_MSG);
            setState(chatId, "IDLE");
            return;
          }

          // Opción 4: Cita
          if (n === "4") {
            await msg.reply("📅 *Agendar una cita*\nPaso 1/4: Indícame tu *nombre completo*.");
            setState(chatId, "CITA_NOMBRE");
            return;
          }

          // Opción 5: Humano  (CAMBIO: avisar al admin)
          if (n === "5") {
            await msg.reply("👤 *Hablar con una persona*\nEn breve un asesor te atenderá.");
            // ---- NUEVO AVISO AL ADMIN ----
            const aviso =
              "👤 *ALERTA HUMANO*\n" +
              "Un cliente quiere hablar contigo.\n" +
              `• Cliente (chatId): ${chatId}`;
            await sendToAdmin(aviso);
            // ------------------------------
            setState(chatId, "HUMANO");
            return;
          }
        }
        return;
      }

      case "INFO_COMPANIA": {
        await msg.reply(
          "Si te interesa, dime *paquetes*, *cobertura*, *internet hogar* o *cómo contratar*, y te doy más detalles puntuales."
        );
        return;
      }

      /* ===== Recargas ===== */
      case "RECARGA_NUMERO": {
        const digits = onlyDigits(text);
        if (!isMxPhone(digits)) {
          await msg.reply("El número debe tener *10 dígitos*. Inténtalo de nuevo.");
          return;
        }
        setState(chatId, "RECARGA_MONTO", { recargaNumero: digits });
        await msg.reply("Paso 2/2: ¿Qué *monto* quieres recargar? Debe ser *110*, *160* o *210*.");
        return;
      }
      case "RECARGA_MONTO": {
        const monto = Number(text.replace(",", ".").trim());
        if (!ALLOWED_AMOUNTS.includes(monto)) {
          await msg.reply("Monto inválido. Debe ser *110*, *160* o *210*.");
          return;
        }
        const { recargaNumero } = getSession(chatId).data;
        await msg.reply(
          `✅ Recarga solicitada: *${recargaNumero}* por *$${monto.toFixed(0)}*. Un asesor confirmará tu recarga.`
        );
        const aviso =
          "💳 *ALERTA RECARGA*\n" +
          `• Cliente: ${chatId}\n` +
          `• Número: ${recargaNumero}\n` +
          `• Monto: $${monto.toFixed(0)}`;
        await sendToAdmin(aviso);
        setState(chatId, "IDLE", {});
        return;
      }

      /* ===== Citas ===== */
      case "CITA_NOMBRE": {
        setState(chatId, "CITA_FECHA_FREEFORM", { nombre: text });
        await msg.reply("Paso 2/4: Escribe la *fecha* (ej.: *próximo jueves*, *17 de agosto*, *17/08/2025*).");
        return;
      }
      case "CITA_FECHA_FREEFORM": {
        let parsed = { isoDate: null, readable: null };
        try { parsed = await parseDateSmart(text); } catch {}
        if (!parsed.isoDate) {
          await msg.reply("No pude interpretar la fecha. Intenta con *mañana*, *próximo jueves* o *17/08/2025*.");
          return;
        }
        setState(chatId, "CITA_FECHA_CONFIRM", {
          fechaTexto: text, fechaISO: parsed.isoDate, fechaReadable: parsed.readable || parsed.isoDate
        });
        await msg.reply(`Entendí la fecha como: *${parsed.readable || parsed.isoDate}* (${parsed.isoDate}). ¿Es correcto? *sí/no*`);
        return;
      }
      case "CITA_FECHA_CONFIRM": {
        if (isYes(text)) {
          setState(chatId, "CITA_HORA_FREEFORM");
          await msg.reply("Paso 3/4: Ahora dime la *hora* (ej.: *3 pm*, *15:00*, *medio día*).");
          return;
        }
        if (isNo(text)) {
          setState(chatId, "CITA_FECHA_FREEFORM");
          await msg.reply("Ok, escribe nuevamente la *fecha*.");
          return;
        }
        await msg.reply("Responde *sí* o *no*.");
        return;
      }
      case "CITA_HORA_FREEFORM": {
        let parsed = { isoTime: null, readable: null };
        try { parsed = await parseTimeSmart(text); } catch {}
        if (!parsed.isoTime) {
          await msg.reply("No pude interpretar la hora. Intenta con *3 pm* o *15:00*.");
          return;
        }
        setState(chatId, "CITA_HORA_CONFIRM", {
          horaTexto: text, horaISO: parsed.isoTime, horaReadable: parsed.readable || parsed.isoTime
        });
        await msg.reply(`Entendí la hora como: *${parsed.readable || parsed.isoTime}* (${parsed.isoTime}). ¿Es correcto? *sí/no*`);
        return;
      }
      case "CITA_HORA_CONFIRM": {
        if (isYes(text)) {
          const data = getSession(chatId).data;
          const { nombre, fechaISO, horaISO } = data;
          const startLocal = new Date(`${fechaISO}T${horaISO}:00`);
          const endLocal   = new Date(startLocal.getTime() + 60 * 60 * 1000); // 60 min
          const startISO   = startLocal.toISOString();
          const endISO     = endLocal.toISOString();

          try {
            const free = await isSlotFree(startISO, endISO);
            if (!free) {
              await msg.reply("⛔ Ese horario ya está ocupado. ¿Propones otra *fecha* u *hora*?");
              setState(chatId, "CITA_FECHA_FREEFORM");
              return;
            }
            const event = await createCalendarEvent({
              summary: `Cita con ${nombre}`,
              description: `Cita agendada vía WhatsApp (${chatId}).`,
              startISO, endISO,
            });
            await msg.reply(`✅ *Cita creada* para *${fechaISO}* a las *${horaISO}*.`);
            const aviso =
              "📅 *ALERTA CITA*\n" +
              `• Cliente: ${chatId}\n` +
              `• Nombre: ${nombre}\n` +
              `• Fecha: ${fechaISO}\n` +
              `• Hora: ${horaISO}\n` +
              `• Evento ID: ${event.id || "N/D"}`;
            await sendToAdmin(aviso);
            setState(chatId, "IDLE", {});
            return;
          } catch (e) {
            console.error("Error Calendar:", e?.message || e);
            await msg.reply("⚠️ No pude verificar/crear la cita en Calendar. Intenta más tarde.");
            setState(chatId, "IDLE");
            return;
          }
        }
        if (isNo(text)) {
          setState(chatId, "CITA_HORA_FREEFORM");
          await msg.reply("Ok, escribe nuevamente la *hora*.");
          return;
        }
        await msg.reply("Responde *sí* o *no*.");
        return;
      }

      /* ===== Portabilidad ===== */
      case "CAMBIO_DATOS": {
        const userText = text;
        setState(chatId, "IDLE", { portabilidadDatos: userText });
        const aviso =
          "📩 *ALERTA PORTABILIDAD*\n" +
          `Un cliente (${chatId}) quiere *cambio de compañía*.\n\n` +
          `📄 *Datos enviados:*\n${userText}`;
        await sendToAdmin(aviso);
        await msg.reply("Perfecto, recibí tu información. Un asesor te contactará. Escribe *hola* para el menú.");
        return;
      }

      case "HUMANO": {
        await msg.reply("En breve, un asesor continuará la conversación. 🙌");
        return;
      }
    }
  } catch (error) {
    console.error("Error en handler:", error);
    try { await msg.reply("⚠️ Ocurrió un error. Escribe *hola* para ver el menú."); } catch {}
  }
});

client.initialize();