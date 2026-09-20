const express = require('express');
const admin = require('firebase-admin');
const qrcode = require('qrcode');

// Baileys v7 es ESM. Este archivo permanece en CommonJS y lo carga con import() dinámico.
let makeWASocket;
let DisconnectReason;
let BufferJSON;
let initAuthCreds;
let downloadMediaMessage;
let Browsers;
let fetchLatestBaileysVersion;

// ================================================================
// CONFIGURACIÓN
// ================================================================
const ROOM_CODE = String(process.env.ROOM_CODE || 'FACEX').trim().toUpperCase();
const API_NUMBER = String(process.env.NUMERO_API_LIMPIO || '').replace(/\D/g, '');
const CRON_SECRET = String(process.env.CRON_SECRET || '');
const PORT = Number(process.env.PORT || 3000);

const app = express();
let db = null;
let sock = null;
let isConnected = false;
let lastQrDataUrl = null;
let connectionState = 'booting';
let connectionError = null;
let reconnectTimer = null;
let schedulerRunning = false;
let lastProcessedMessageKey = '';

// ================================================================
// DIAGNÓSTICO HTTP / QR
// ================================================================
app.get('/', (req, res) => {
  const qrLink = isConnected ? '' : '<a href="/qr" style="display:inline-block;margin:6px;padding:10px 15px;border-radius:10px;background:#0eaa79;color:#fff;text-decoration:none">Ver QR</a>';
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"></head><body style="font-family:Arial;text-align:center;padding:40px">
  <h2>🟢 TaskKeep WhatsApp Bot</h2>
  <p>Estado: <b>${isConnected ? '✅ Conectado' : '⏳ ' + escapeHtml(connectionState)}</b></p>
  <p>Sala: <b>${escapeHtml(ROOM_CODE)}</b></p>
  <p>${connectionError ? escapeHtml(connectionError) : 'Sin error actual.'}</p>
  <p style="font-size:12px;color:#8a4b00">Firebase: ${db ? '✅ conectado' : '❌ no conectado'}</p>
  ${qrLink}
  <a href="/status" style="display:inline-block;margin:6px;padding:10px 15px;border-radius:10px;background:#eef2f6;color:#234;text-decoration:none">Estado técnico</a>
  <a href="/reset" style="display:inline-block;margin:6px;padding:10px 15px;border-radius:10px;background:#ffe8ed;color:#a22;text-decoration:none">Reset WhatsApp</a>
  <p style="font-size:12px;color:#687787">Privacidad: solo chat propio y chat API · whatsappHistory: desactivado</p>
  </body></html>`);
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    room: ROOM_CODE,
    connected: isConnected,
    state: connectionState,
    qrAvailable: Boolean(lastQrDataUrl),
    firebase: { connected: Boolean(db), error: db ? null : connectionError },
    apiConfigured: Boolean(API_NUMBER),
    scheduler: schedulerRunning,
    updatedAt: new Date().toISOString(),
    error: connectionError
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<meta http-equiv="refresh" content="10"><div style="font-family:Arial;text-align:center;padding:50px"><h2>✅ WhatsApp conectado</h2><p>TaskKeep está escuchando mensajes.</p><a href="/status">Estado técnico</a></div>');
  if (!lastQrDataUrl) {
    return res.send('<meta http-equiv="refresh" content="3"><div style="font-family:Arial;text-align:center;padding:50px"><h2>⏳ Esperando QR</h2><p id="state">' + escapeHtml(connectionState) + '</p><p>Esta pantalla se actualiza automáticamente.</p><a href="/status">Ver estado técnico</a></div>');
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="8"></head><body style="font-family:Arial;text-align:center;padding:30px">
    <h2>Escanea este código QR</h2>
    <p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
    <img src="${lastQrDataUrl}" style="max-width:320px;border:1px solid #ddd;padding:12px;border-radius:14px">
    <p style="font-size:12px;color:#667">El QR se renueva automáticamente. Escanea siempre el más reciente.</p>
    <a href="/status">Estado técnico</a>
  </body></html>`);
});

app.get('/reset', async (req, res) => {
  try {
    connectionError = null;
    isConnected = false;
    lastQrDataUrl = null;
    connectionState = 'resetting';

    if (sock) {
      try { sock.ws?.close?.(); } catch {}
      try { sock.end?.(new Error('manual reset')); } catch {}
    }
    sock = null;

    if (db) {
      const snap = await db.collection('bot_auth').get();
      const batch = db.batch();
      snap.forEach(doc => batch.delete(doc.ref));
      if (snap.size) await batch.commit();
      console.log(`🧹 bot_auth eliminado: ${snap.size} documento(s).`);
    }

    res.send('<div style="font-family:Arial;text-align:center;padding:45px"><h2>♻️ Sesión limpiada</h2><p>Render reiniciará el bot y se generará un QR nuevo.</p><a href="/qr">Abrir QR</a></div>');
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    console.error('❌ Error en /reset:', e);
    res.status(500).send('Error en reset: ' + escapeHtml(e.message || String(e)));
  }
});

// ================================================================
// FIREBASE ADMIN
// ================================================================
function parseServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  const rawB64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '').trim();

  let obj = null;

  const parseJsonValue = (value, label) => {
    let s = String(value || '').trim();
    // Algunas configuraciones de Render pegan el JSON entre comillas externas.
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      try { s = JSON.parse(s); } catch {}
    }
    try {
      return typeof s === 'string' ? JSON.parse(s) : s;
    } catch (e) {
      throw new Error(`${label} no contiene JSON válido: ${e.message}`);
    }
  };

  if (raw) {
    obj = parseJsonValue(raw, 'FIREBASE_SERVICE_ACCOUNT');
  } else if (rawB64) {
    let decoded;
    try { decoded = Buffer.from(rawB64, 'base64').toString('utf8'); }
    catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 no se pudo decodificar: ' + e.message); }
    obj = parseJsonValue(decoded, 'FIREBASE_SERVICE_ACCOUNT_B64');
  } else if (process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_CLIENT_EMAIL || process.env.FIREBASE_PRIVATE_KEY) {
    obj = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('No existe una credencial Firebase utilizable.');
  }

  const projectId = String(obj.project_id ?? obj.projectId ?? '').trim();
  const clientEmail = String(obj.client_email ?? obj.clientEmail ?? '').trim();
  const privateKey = String(obj.private_key ?? obj.privateKey ?? '').replace(/\\n/g, '\n').trim();

  if (!projectId) throw new Error('Falta project_id/projectId en la credencial Firebase.');
  if (!clientEmail) throw new Error('Falta client_email/clientEmail en la credencial Firebase.');
  if (!privateKey || !privateKey.includes('BEGIN PRIVATE KEY')) throw new Error('Falta private_key/privateKey válida en la credencial Firebase.');

  // Devolvemos ambas variantes para conservar compatibilidad con distintas versiones
  // del SDK Admin. La primera tentativa usa la credencial original sin transformarla.
  return {
    original: obj,
    normalized: { projectId, clientEmail, privateKey },
    projectId,
    clientEmail,
    privateKey
  };
}

function initFirebase() {
  try {
    const sa = parseServiceAccount();

    // Intento 1: exactamente el objeto recibido desde Render.
    // Esto conserva el comportamiento que funcionaba en las versiones anteriores.
    try {
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(sa.original) });
      }
      db = admin.firestore();
      console.log(`✅ Firebase conectado correctamente: ${sa.projectId}`);
      return true;
    } catch (firstError) {
      console.error('⚠️ Firebase: falló credencial original:', firstError?.message || String(firstError));

      // Si el formato original no es aceptado por la versión del SDK, reutilizamos
      // una representación explícita projectId/clientEmail/privateKey.
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(sa.normalized) });
      }
      db = admin.firestore();
      console.log(`✅ Firebase conectado con credencial normalizada: ${sa.projectId}`);
      return true;
    }
  } catch (e) {
    db = null;
    connectionState = 'firebase_error';
    connectionError = e?.stack || e?.message || String(e);
    console.error('❌ Error Firebase:', connectionError);
    return false;
  }
}

// ================================================================
// AUTH STATE EN FIRESTORE
// ================================================================
function getAuthCollection() {
  return db.collection('bot_auth');
}

async function useFirestoreAuth() {
  const collectionRef = getAuthCollection();

  const readData = async (key) => {
    const snap = await collectionRef.doc(key).get();
    if (!snap.exists) return null;
    const value = snap.data()?.value;
    if (typeof value !== 'string') return null;
    return JSON.parse(value, BufferJSON.reviver);
  };

  const writeData = async (key, value) => {
    if (value === null || value === undefined) {
      await collectionRef.doc(key).delete();
      return;
    }
    await collectionRef.doc(key).set({ value: JSON.stringify(value, BufferJSON.replacer) });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const value = await readData(`${type}-${id}`);
          if (value !== null && value !== undefined) result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        const jobs = [];
        for (const type of Object.keys(data || {})) {
          for (const id of Object.keys(data[type] || {})) {
            jobs.push(writeData(`${type}-${id}`, data[type][id]));
          }
        }
        await Promise.all(jobs);
      }
    }
  };

  return { state, saveCreds: () => writeData('creds', creds) };
}

// ================================================================
// IDENTIDAD / PRIVACIDAD
// ================================================================
function cleanDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function jidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function normalizeJid(jid) {
  const s = String(jid || '');
  const user = jidUser(s);
  const server = s.split('@')[1] || '';
  return user && server ? `${user}@${server}` : s;
}

function exactSameJid(a, b) {
  return normalizeJid(a) === normalizeJid(b);
}

function authorizedChatForMessage(message) {
  const key = message?.key || {};
  const candidates = [key.remoteJid, key.remoteJidAlt].filter(Boolean);

  const ownPn = sock?.user?.id || '';
  const ownLid = sock?.user?.lid || '';
  const ownPnUser = cleanDigits(jidUser(ownPn));
  const ownLidUser = cleanDigits(jidUser(ownLid));

  const isOwn = candidates.some(jid => {
    const raw = normalizeJid(jid);
    if (ownPn && exactSameJid(raw, ownPn)) return true;
    if (ownLid && exactSameJid(raw, ownLid)) return true;
    const user = cleanDigits(jidUser(raw));
    return Boolean(user && ((ownPnUser && user === ownPnUser) || (ownLidUser && user === ownLidUser)));
  });

  const isApi = API_NUMBER && candidates.some(jid => {
    return cleanDigits(jidUser(jid)) === API_NUMBER && /@(s\.whatsapp\.net|lid)$/.test(String(jid));
  });

  if (isOwn) return { allowed: true, kind: 'SELF' };
  if (isApi) return { allowed: true, kind: 'API' };
  return { allowed: false, kind: 'THIRD_PARTY' };
}

// ================================================================
// MENSAJES
// ================================================================
function unwrapMessage(msg) {
  let m = msg?.message;
  if (!m) return null;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
  return m;
}

function extractText(m) {
  return String(
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.listResponseMessage?.title ||
    m?.templateButtonReplyMessage?.selectedDisplayText ||
    m?.interactiveResponseMessage?.body?.text ||
    m?.interactiveMessage?.body?.text ||
    ''
  ).trim();
}

async function downloadAttachment(msg, m) {
  const attachments = [];

  const targets = [];
  if (m?.audioMessage) targets.push(['audio', m.audioMessage]);
  if (m?.imageMessage) targets.push(['image', m.imageMessage]);
  if (m?.documentMessage) targets.push(['document', m.documentMessage]);
  if (m?.videoMessage) targets.push(['video', m.videoMessage]);

  for (const [kind, media] of targets) {
    try {
      const messageForDownload = { ...msg, message: m };
      const buffer = await downloadMediaMessage(messageForDownload, 'buffer', {});
      const mime = String(media?.mimetype || (kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/ogg' : 'application/octet-stream'));
      const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
      const name = media?.fileName || `${kind}_${Date.now()}.${ext}`;
      attachments.push({
        name,
        type: mime,
        size: buffer.length,
        base64: buffer.toString('base64')
      });
    } catch (e) {
      console.error(`⚠️ No se pudo descargar ${kind}:`, e.message || String(e));
    }
  }

  return attachments;
}

async function saveAuthorizedMessage(msg, kind) {
  if (!db) return;
  const m = unwrapMessage(msg);
  if (!m) {
    console.log(`⚠️ Mensaje autorizado sin contenido descifrado. kind=${kind} id=${msg?.key?.id || ''}`);
    return;
  }

  const key = `${normalizeJid(msg.key?.remoteJid)}|${msg.key?.id || ''}|${Boolean(msg.key?.fromMe)}`;
  if (key && key === lastProcessedMessageKey) return;
  lastProcessedMessageKey = key;

  // Ignorar mensajes de sistema/protocolo. No son tareas de usuario.
  const contentType = Object.keys(m)[0] || '';
  if (/protocolMessage|senderKeyDistributionMessage|messageContextInfo/.test(contentType) && !extractText(m)) {
    console.log(`⏩ Sistema/protocolo ignorado: ${contentType}`);
    return;
  }

  const text = extractText(m);
  const attachments = await downloadAttachment(msg, m);
  const finalText = text || (attachments.length ? `[Archivo adjunto${attachments.length > 1 ? 's' : ''}]` : '');
  if (!finalText && !attachments.length) {
    console.log(`⏩ Mensaje sin contenido procesable: ${msg.key?.id || ''}`);
    return;
  }

  await db.collection('inbox').add({
    room: ROOM_CODE,
    sender: msg.pushName || (kind === 'SELF' ? 'Yo (WhatsApp)' : 'API'),
    text: finalText,
    attachments,
    source: 'whatsapp',
    sourceChat: normalizeJid(msg.key?.remoteJid || ''),
    sourceKind: kind,
    whatsappMessageId: msg.key?.id || '',
    timestamp: Date.now()
  });

  console.log(`✅ WhatsApp → Buzón | ${kind} | ${msg.key?.remoteJid || ''} | ${finalText.slice(0, 80)}`);
}

// ================================================================
// WHATSAPP SOCKET
// ================================================================
async function fetchWaWebVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch('https://web.whatsapp.com/sw.js', {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131 Safari/537.36' }
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const body = await response.text();
    const match = body.match(/client_revision\\?":\\s*(\\d+)/);
    return match?.[1] ? [2, 3000, Number(match[1])] : null;
  } catch (e) {
    console.log('⚠️ No se pudo consultar revisión WA Web:', e.message || String(e));
    return null;
  }
}

async function startWhatsApp() {
  if (!db) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  connectionState = 'loading_baileys';
  connectionError = null;

  if (!makeWASocket) {
    const mod = await import('@whiskeysockets/baileys');
    makeWASocket = mod.default;
    DisconnectReason = mod.DisconnectReason;
    BufferJSON = mod.BufferJSON;
    initAuthCreds = mod.initAuthCreds;
    downloadMediaMessage = mod.downloadMediaMessage;
    Browsers = mod.Browsers;
    fetchLatestBaileysVersion = mod.fetchLatestBaileysVersion;
  }

  const { state, saveCreds } = await useFirestoreAuth();
  const waWebVersion = await fetchWaWebVersion();

  const options = {
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    getMessage: async () => undefined,
    enableAutoSessionRecreation: true
  };

  if (waWebVersion) {
    options.version = waWebVersion;
    console.log('🌐 WA Web revision:', waWebVersion.join('.'));
  } else if (typeof fetchLatestBaileysVersion === 'function') {
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) {
        options.version = latest.version;
        console.log('🌐 Baileys WA version fallback:', latest.version.join('.'));
      }
    } catch (e) {
      console.log('⚠️ No se pudo obtener versión Baileys:', e.message || String(e));
    }
  }

  connectionState = 'opening_socket';
  console.log('🔌 Abriendo socket WhatsApp...');
  sock = makeWASocket(options);

  sock.ev.on('creds.update', saveCreds);

  // Mantener cache propio LID ↔ PN cuando WhatsApp lo proporcione.
  sock.ev.on('lid-mapping.update', async (mapping) => {
    try {
      if (mapping?.lid && mapping?.pn && sock?.signalRepository?.lidMapping?.storeLIDPNMappings) {
        await sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: mapping.lid, pn: mapping.pn }]);
        console.log(`🔗 LID↔PN actualizado: ${mapping.lid} ↔ ${mapping.pn}`);
      }
    } catch (e) {
      console.log('⚠️ No se pudo guardar LID↔PN:', e.message || String(e));
    }
  });

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
      connectionState = 'qr_ready';
      console.log('📲 NUEVO QR DISPONIBLE en /qr');
    }

    if (connection === 'open') {
      isConnected = true;
      connectionState = 'connected';
      connectionError = null;
      lastQrDataUrl = null;
      console.log('🟢 WhatsApp conectado y escuchando.');
      console.log(`👤 Propia cuenta PN: ${sock.user?.id || '(no disponible)'}`);
      console.log(`🆔 Propia cuenta LID: ${sock.user?.lid || '(no disponible)'}`);
    }

    if (connection === 'close') {
      isConnected = false;
      lastQrDataUrl = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const message = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'Connection closed');
      connectionError = `${code || 'sin código'} ${message}`;
      connectionState = code === 401 ? 'logged_out' : 'reconnecting';
      console.error(`❌ WhatsApp cerrado | código=${code} | ${message}`);

      if (code === DisconnectReason?.loggedOut) {
        console.error('🔐 Sesión cerrada por WhatsApp. Usa /reset para volver a vincular.');
        return;
      }

      if (code === 405) console.error('⚠️ 405 client_too_old. Se volverá a consultar la versión WA Web.');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => startWhatsApp().catch(err => console.error('❌ Error reconectando:', err)), 5000);
    }
  });

  sock.ev.on('messages.upsert', async event => {
    const type = event?.type;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    console.log(`📥 messages.upsert type=${type} cantidad=${messages.length}`);

    for (const msg of messages) {
      try {
        if (!msg?.key?.remoteJid) continue;
        const auth = authorizedChatForMessage(msg);
        console.log(`🔎 Mensaje ${msg.key.id || ''} chat=${msg.key.remoteJid} alt=${msg.key.remoteJidAlt || ''} fromMe=${Boolean(msg.key.fromMe)} → ${auth.kind}`);

        if (!auth.allowed) continue;
        // notify = mensajes nuevos en tiempo real. Para SELF también aceptamos append,
        // porque WhatsApp puede entregar mensajes propios del dispositivo principal
        // como histórico/offline. syncFullHistory permanece desactivado para evitar
        // importar el historial completo al Buzón.
        if (type !== 'notify' && type !== 'append') continue;

        await saveAuthorizedMessage(msg, auth.kind);
      } catch (e) {
        console.error('❌ Error procesando mensaje WhatsApp:', e.message || String(e));
      }
    }
  });
}

// ================================================================
// CRON DINÁMICO DESDE INDEX → FIREBASE
// ================================================================
function peruClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now).filter(x => x.type !== 'literal');
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour}:${p.minute}`,
    hms: `${p.hour}:${p.minute}:${p.second}`
  };
}

function cleanPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildReport(docs) {
  const groups = {};
  for (const doc of docs) {
    const t = doc.data() || {};
    (groups[t.assignee || 'General'] ||= []).push(t);
  }
  const c = peruClock();
  let out = `A las ${c.hms} del ${Number(c.date.slice(8,10))}/${Number(c.date.slice(5,7))}/${c.date.slice(0,4)},\n\nLos pendientes son:\n\n`;
  for (const [person, items] of Object.entries(groups)) {
    out += `👤 ${person}\n\n`;
    items.forEach((t, i) => { out += `${i + 1}. ${t.title}\n\n`; });
  }
  return out.trimEnd();
}

async function runScheduledReport(source = 'internal') {
  if (!db || !sock || !isConnected) return { sent: false, reason: 'WhatsApp no conectado' };

  const cfgSnap = await db.collection('settings').doc(`report_settings_${ROOM_CODE}`).get();
  if (!cfgSnap.exists) return { sent: false, reason: 'No existe report_settings para la sala' };
  const cfg = cfgSnap.data() || {};
  const target = String(cfg.scheduleTime || '').slice(0, 5);
  const clock = peruClock();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(target)) return { sent: false, reason: 'scheduleTime inválida' };
  if (clock.hm !== target) return { sent: false, reason: `Fuera de hora: ${clock.hm}; objetivo ${target}` };

  const lockRef = db.collection('settings').doc(`cron_lock_${ROOM_CODE}`);
  const lockSnap = await lockRef.get();
  if (lockSnap.exists && String(lockSnap.data()?.date || '') === clock.date) return { sent: false, reason: 'Ya enviado hoy' };

  const taskSnap = await db.collection('tasks')
    .where('room', '==', ROOM_CODE)
    .where('done', '==', false)
    .where('status', '==', 'active')
    .get();

  if (taskSnap.empty) return { sent: false, reason: 'No hay pendientes' };

  const phoneK = cleanPhone(cfg.phoneK);
  const phoneO = cleanPhone(cfg.phoneO);
  const targets = [['K', phoneK], ['O', phoneO]].filter(([, p]) => p);
  if (!targets.length) return { sent: false, reason: 'No hay teléfonos K/O configurados en index' };

  const text = buildReport(taskSnap.docs);
  const sent = [];
  for (const [label, phone] of targets) {
    try {
      await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
      sent.push(label);
      console.log(`✅ Cron ${source}: reporte enviado a ${label}`);
    } catch (e) {
      console.error(`❌ Cron ${source}: error enviando a ${label}:`, e.message || String(e));
    }
  }

  if (sent.length) {
    await lockRef.set({ room: ROOM_CODE, date: clock.date, sentAt: Date.now(), sentTo: sent, source }, { merge: true });
  }

  return { sent: sent.length > 0, sentTo: sent, reason: sent.length ? 'Enviado' : 'Fallaron destinatarios' };
}

app.get('/cron-tick', async (req, res) => {
  if (CRON_SECRET && req.query.key !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const result = await runScheduledReport('cron-job.org');
    res.json({ ok: true, ...result, now: peruClock() });
  } catch (e) {
    console.error('❌ /cron-tick:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

async function schedulerLoop() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  setInterval(async () => {
    try { await runScheduledReport('internal'); } catch (e) { console.error('❌ Scheduler:', e.message || String(e)); }
  }, 10000);
}

// ================================================================
// ARRANQUE
// ================================================================
app.listen(PORT, () => console.log(`🚀 HTTP activo en puerto ${PORT}`));

(async () => {
  if (!initFirebase()) return;
  await schedulerLoop();
  try {
    await startWhatsApp();
  } catch (e) {
    connectionState = 'startup_error';
    connectionError = e.message || String(e);
    console.error('❌ ERROR FATAL WhatsApp:', e);
    setTimeout(() => startWhatsApp().catch(err => console.error('❌ Retry startup:', err)), 5000);
  }
})();

function escapeHtml(value) {
  return String(value || '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
}
