const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, downloadMediaMessage } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const admin = require('firebase-admin');

// =========================================================================
// ⚙️ TUS CONFIGURACIONES PRINCIPALES
// =========================================================================
const ROOM_CODE = process.env.ROOM_CODE || 'FACEX'; // Tu sala de TaskKeep

// Pon aquí los dígitos del número de tu API de WhatsApp (sin signos +, sin espacios)
const NUMERO_API_LIMPIO = '15556741749'; // Reemplaza por el número real de tu API

// Teléfonos para el reporte diario de las 9:00 AM
const DESTINATARIOS_CRON_FALLBACK = [
  '51952507450@s.whatsapp.net',
  '51952507450@s.whatsapp.net'
];

// =========================================================================
// 1. SERVIDOR WEB EXPRESS (OBLIGATORIO PARA RENDER Y UPTIMEROBOT)
// =========================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let lastQrSvg = null;
let isConnected = false;
let globalSock = null;

app.get('/', (req, res) => {
  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>🟢 TaskKeep WhatsApp Bot</h2>
      <p>Estado WhatsApp: <b>${isConnected ? '✅ Conectado y escuchando' : '⏳ Esperando escaneo de QR'}</b></p>
      <p>Sala activa: <b>${ROOM_CODE}</b></p>
      <p style="color:gray;font-size:12px">Filtro activo: Solo chat propio ("Tú") y API (${NUMERO_API_LIMPIO})</p>
      <div style="margin-top:20px">
        <a href="/qr" style="background:#0f9d73;color:white;padding:10px 16px;border-radius:8px;text-decoration:none;margin-right:10px">Ver Código QR</a>
        <a href="/reset" onclick="return confirm('¿Reiniciar sesión dañada?')" style="background:#e85b72;color:white;padding:10px 16px;border-radius:8px;text-decoration:none">Reiniciar Sesión Dañada</a>
      </div>
    </div>
  `);
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<h3>✅ WhatsApp ya está vinculado y funcionando correctamente.</h3>');
  if (!lastQrSvg) return res.send('<h3>Generando nuevo código QR... recarga en 3 segundos.</h3>');
  res.send(`
    <div style="text-align:center;padding:30px;font-family:sans-serif">
      <h2>Escanea este QR con WhatsApp</h2>
      <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
      <img src="${lastQrSvg}" style="border:1px solid #ccc;padding:10px;border-radius:12px;max-width:300px"/>
    </div>
  `);
});

// Limpieza de sesión dañada si hiciera falta
app.get('/reset', async (req, res) => {
  try {
    if (db) {
      const snap = await db.collection('bot_auth').get();
      const batch = db.batch();
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    if (globalSock) {
      try { globalSock.logout(); } catch(e){}
    }
    isConnected = false;
    lastQrSvg = null;
    setTimeout(() => startBot(), 2000);
    res.send('<h3>🧹 Sesión anterior limpiada. Ve a <a href="/qr">/qr</a> para escanear el nuevo código.</h3>');
  } catch (err) {
    res.send('Error limpiando sesión: ' + err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));

// =========================================================================
// 2. INICIALIZAR FIREBASE ADMIN
// =========================================================================
let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('❌ Error parseando FIREBASE_SERVICE_ACCOUNT:', e.message);
  }
}

let db = null;
if (serviceAccount) {
  try {
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('✅ Firebase conectado correctamente.');
  } catch (err) {
    console.error('❌ Error Firebase:', err.message);
  }
}

// =========================================================================
// 3. PERSISTENCIA SEGURA DE SESIÓN CON BUFFERJSON
// =========================================================================
async function useFirestoreAuthSafe(collectionRef) {
  const readData = async (key) => {
    try {
      const doc = await collectionRef.doc(key).get();
      if (!doc.exists) return null;
      return JSON.parse(doc.data().value, BufferJSON.reviver);
    } catch (e) { return null; }
  };

  const writeData = async (key, value) => {
    try {
      if (value === null || value === undefined) {
        await collectionRef.doc(key).delete();
      } else {
        await collectionRef.doc(key).set({ value: JSON.stringify(value, BufferJSON.replacer) });
      }
    } catch (e) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const val = await readData(`${type}-${id}`);
              if (val) data[id] = val;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const cat of Object.keys(data)) {
            for (const id of Object.keys(data[cat])) {
              tasks.push(writeData(`${cat}-${id}`, data[cat][id]));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
}

// =========================================================================
// 4. LÓGICA DE WHATSAPP CON FILTRO DE PRIVACIDAD INTELIGENTE
// =========================================================================

function normalizeJidNumber(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function getLimaDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    hourMinute: `${parts.hour}:${parts.minute}`
  };
}

async function purgeWhatsAppHistoryForRoom() {
  if (!db) return;
  try {
    const snap = await db.collection('whatsappHistory').where('room', '==', ROOM_CODE).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`🧹 Historial WhatsApp eliminado de la sala ${ROOM_CODE}: ${snap.size} registro(s).`);
  } catch (e) {
    console.error('No se pudo limpiar whatsappHistory:', e.message);
  }
}

async function getCronSettings() {
  const defaults = {
    scheduleTime: '09:00',
    recipients: DESTINATARIOS_CRON_FALLBACK
  };
  try {
    const ref = db.collection('settings').doc('report_settings_' + ROOM_CODE);
    const snap = await ref.get();
    if (!snap.exists) return defaults;
    const data = snap.data() || {};
    const configured = [data.phoneK, data.phoneO]
      .map(normalizeJidNumber)
      .filter(Boolean)
      .map(n => `${n}@s.whatsapp.net`);
    return {
      scheduleTime: data.scheduleTime || '09:00',
      recipients: configured.length ? [...new Set(configured)] : defaults.recipients
    };
  } catch (e) {
    console.error('No se pudo leer configuración del reporte:', e.message);
    return defaults;
  }
}

function buildCronReport(tasksRows, lima) {
  const groups = {};
  for (const t of tasksRows) (groups[t.assignee || 'General'] ||= []).push(t);
  let report = `A las ${lima.time} del ${lima.date},

Los pendientes son:

`;
  for (const [person, items] of Object.entries(groups)) {
    report += `👤 ${person}

`;
    items.forEach((t, i) => {
      report += `${i + 1}. ${t.title}

`;
    });
  }
  return report.trimEnd();
}
async function startBot() {
  if (!db) {
    console.log('⏳ Esperando credenciales de Firebase...');
    return;
  }

  const authRef = db.collection('bot_auth');
  const { state, saveCreds } = await useFirestoreAuthSafe(authRef);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    getMessage: async () => undefined
  });
  globalSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      lastQrSvg = await qrcode.toDataURL(qr);
      console.log('📲 Nuevo código QR disponible en /qr');
    }
    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Conexión cerrada (código ${statusCode}). ¿Reconectar?:`, shouldReconnect);
      if (shouldReconnect) setTimeout(() => startBot(), 3000);
    } else if (connection === 'open') {
      isConnected = true;
      lastQrSvg = null;
      console.log('🟢 WhatsApp conectado y listo para recibir mensajes.');
    }
  });

  // ESCUCHAR MENSAJES Y FILTRAR PRIVACIDAD
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg) continue;

      // 1. Desenvolver mensaje si viene como temporal o vista única
      let m = msg.message;
      if (m?.ephemeralMessage) m = m.ephemeralMessage.message;
      if (m?.viewOnceMessage) m = m.viewOnceMessage.message;
      if (m?.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
      if (m?.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

      if (!m) continue;

      const chatOrigen = msg.key.remoteJid || '';

      // 2. FILTRO DE PRIVACIDAD: SOLO CHAT CONTIGO MISMA O CHAT CON LA API
      const chatCandidates = [msg.key.remoteJid, msg.key.remoteJidAlt]
        .filter(Boolean)
        .map(normalizeJidNumber)
        .filter(Boolean);
      const miNumero = normalizeJidNumber(sock.user?.id);
      const miLid = normalizeJidNumber(sock.user?.lid);
      const apiDigits = normalizeJidNumber(NUMERO_API_LIMPIO);

      // Solo se autoriza el JID exacto de tu propio chat o el número exacto de la API.
      // Esto evita capturar mensajes que tú envíes a terceros aunque el evento tenga fromMe=true.
      const esConmigoMisma = Boolean(
        chatCandidates.some(x => x === miNumero || x === miLid)
      );
      const esConApi = Boolean(apiDigits && chatCandidates.includes(apiDigits));

      if (!esConmigoMisma && !esConApi) {
        console.log(`⏩ Mensaje ignorado por privacidad: ${chatOrigen}`);
        continue;
      }

      console.log(`📩 Mensaje autorizado: ${esConmigoMisma ? 'chat propio' : 'chat API'} [${chatOrigen}]`);

      const sender = msg.pushName || 'Yo (WhatsApp)';
      let text = m.conversation || m.extendedTextMessage?.text || '';
      let attachments = [];

      // Si es audio / nota de voz
      if (m.audioMessage) {
        console.log('🎙️ Audio detectado. Descargando...');
        try {
          const buffer = await downloadMediaMessage({ ...msg, message: m }, 'buffer', {});
          attachments.push({
            name: `audio_${Date.now()}.ogg`,
            type: 'audio/ogg',
            size: buffer.length,
            base64: buffer.toString('base64')
          });
          if (!text) text = '[Nota de voz reenviada desde WhatsApp]';
        } catch (err) {
          console.error('Error descargando audio:', err.message);
        }
      }

      // Si es imagen o PDF
      if (m.imageMessage || m.documentMessage) {
        try {
          const isImg = !!m.imageMessage;
          const buffer = await downloadMediaMessage({ ...msg, message: m }, 'buffer', {});
          const mime = isImg ? 'image/jpeg' : (m.documentMessage?.mimetype || 'application/pdf');
          const fileName = isImg ? `img_${Date.now()}.jpg` : (m.documentMessage?.fileName || 'documento.pdf');
          attachments.push({
            name: fileName,
            type: mime,
            size: buffer.length,
            base64: buffer.toString('base64')
          });
          if (!text) text = `[Archivo adjunto: ${fileName}]`;
        } catch (err) {
          console.error('Error descargando archivo:', err.message);
        }
      }

      if (text || attachments.length) {
        try {
          // 1. Guardar en el Buzón de Firebase
          await db.collection('inbox').add({
            room: ROOM_CODE,
            sender: sender,
            text: text,
            attachments: attachments,
            timestamp: Date.now()
          });

          console.log(`✅ ¡ÉXITO! Mensaje guardado en el Buzón de la sala ${ROOM_CODE}.`);
        } catch (dbErr) {
          console.error('Error en Firebase:', dbErr.message);
        }
      }
    }
  });

  // =========================================================================
  // 5. REPORTE PROGRAMADO DINÁMICO (SIN HORA FIJA)
  // =========================================================================
  let ultimaEjecucionKey = '';
  let configCache = { scheduleTime: '09:00', recipients: DESTINATARIOS_CRON_FALLBACK };

  // Cada 5 segundos: permite cambiar la hora desde TaskKeep y probar incluso durante
  // el minuto actual, sin esperar al siguiente día.
  cron.schedule('*/5 * * * * *', async () => {
    try {
      const lima = getLimaDateTime();
      configCache = await getCronSettings();
      const objetivo = String(configCache.scheduleTime || '09:00').slice(0, 5);
      const key = `${lima.isoDate}_${objetivo}`;

      if (lima.hourMinute !== objetivo || ultimaEjecucionKey === key) return;

      const snap = await db.collection('tasks')
        .where('room', '==', ROOM_CODE)
        .where('done', '==', false)
        .where('status', '==', 'active')
        .get();

      if (snap.empty) {
        ultimaEjecucionKey = key;
        console.log(`⏰ ${lima.time}: no hay pendientes para enviar.`);
        return;
      }

      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const report = buildCronReport(rows, lima);
      const recipients = [...new Set(configCache.recipients || [])].filter(Boolean);

      if (!recipients.length) {
        console.error('⚠️ No hay destinatarios K/O configurados para el reporte.');
        return;
      }

      ultimaEjecucionKey = key;
      for (const jid of recipients) {
        try {
          await sock.sendMessage(jid, { text: report });
          console.log(`✅ Reporte automático enviado a ${jid}.`);
        } catch (sendErr) {
          console.error(`❌ No se pudo enviar a ${jid}:`, sendErr.message);
        }
      }
    } catch (e) {
      console.error('Error en reporte programado dinámico:', e.message);
    }
  });
}

purgeWhatsAppHistoryForRoom().finally(() => startBot());
