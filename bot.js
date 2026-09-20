const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, downloadMediaMessage } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const admin = require('firebase-admin');

// =========================================================================
// ⚙️ CONFIGURACIONES PRINCIPALES
// =========================================================================
const ROOM_CODE = process.env.ROOM_CODE || 'EQUIPO1';
const NUMERO_API_LIMPIO = '15556741749'; // Número de tu API WhatsApp

const DESTINATARIOS_CRON = [
  '51952507450@s.whatsapp.net',
  '51952507450@s.whatsapp.net'
];

// =========================================================================
// 1. SERVIDOR WEB EXPRESS
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
      <p>Estado: <b>${isConnected ? '✅ Conectado' : '⏳ Esperando QR'}</b></p>
      <p>Sala: <b>${ROOM_CODE}</b></p>
      <div style="margin-top:20px">
        <a href="/qr" style="background:#0f9d73;color:white;padding:10px 16px;border-radius:8px;text-decoration:none;margin-right:10px">Ver QR</a>
        <a href="/reset" onclick="return confirm('¿Reiniciar sesión?')" style="background:#e85b72;color:white;padding:10px 16px;border-radius:8px;text-decoration:none">Reiniciar Sesión</a>
      </div>
    </div>
  `);
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<h3>✅ WhatsApp vinculado correctamente.</h3>');
  if (!lastQrSvg) return res.send('<h3>Generando QR... recarga en 3 segundos.</h3>');
  res.send(`
    <div style="text-align:center;padding:30px;font-family:sans-serif">
      <h2>Escanea este QR con WhatsApp</h2>
      <p>WhatsApp > Dispositivos vinculados > Vincular dispositivo</p>
      <img src="${lastQrSvg}" style="border:1px solid #ccc;padding:10px;border-radius:12px;max-width:300px"/>
    </div>
  `);
});

app.get('/reset', async (req, res) => {
  try {
    if (db) {
      const snap = await db.collection('bot_auth').get();
      const batch = db.batch();
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    if (globalSock) { try { globalSock.logout(); } catch(e){} }
    isConnected = false;
    lastQrSvg = null;
    setTimeout(() => startBot(), 2000);
    res.send('<h3>🧹 Sesión limpiada. Ve a <a href="/qr">/qr</a> para escanear.</h3>');
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));

// =========================================================================
// 2. FIREBASE ADMIN
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
    console.log('✅ Firebase conectado.');
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
    } catch (e) { console.error('Error escribiendo auth:', e.message); }
  };

  let creds = await readData('creds');
  if (!creds) creds = initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            const val = await readData(`${type}-${id}`);
            if (val) data[id] = val;
          }));
          return data;
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, vals]) =>
              Object.entries(vals).map(([id, val]) => writeData(`${type}-${id}`, val))
            )
          );
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    }
  };
}

// =========================================================================
// 4. GUARDAR EN BUZÓN (INBOX)
// =========================================================================
async function guardarEnBuzon(texto, tipo = 'texto', extras = {}) {
  if (!db) return;
  try {
    await db.collection('inbox').add({
      room: ROOM_CODE,
      mensaje: texto,
      tipo,
      procesado: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ...extras
    });
    console.log(`📥 Guardado en buzón [${tipo}]:`, texto?.substring(0, 80));
  } catch (e) {
    console.error('Error guardando en buzón:', e.message);
  }
}

// =========================================================================
// 5. BOT PRINCIPAL
// =========================================================================
async function startBot() {
  const collectionRef = db ? db.collection('bot_auth') : null;
  
  let authState, saveCreds;
  if (collectionRef) {
    const result = await useFirestoreAuthSafe(collectionRef);
    authState = result.state;
    saveCreds = result.saveCreds;
  } else {
    const { makeInMemoryStore } = require('@whiskeysockets/baileys');
    const { state, saveCreds: sc } = await require('@whiskeysockets/baileys').useMultiFileAuthState('./auth_info');
    authState = state;
    saveCreds = sc;
  }

  const sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    browser: ['TaskKeep Bot', 'Chrome', '1.0'],
  });

  globalSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        lastQrSvg = await qrcode.toDataURL(qr);
        console.log('📱 QR generado. Ve a /qr para escanearlo.');
      } catch (e) { console.error('Error generando QR:', e); }
    }

    if (connection === 'open') {
      isConnected = true;
      console.log('✅ WhatsApp conectado correctamente.');
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Desconectado. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(() => startBot(), 5000);
    }
  });

  // =========================================================================
  // 6. FILTRO DE MENSAJES — Solo "Tú" y número de API
  // =========================================================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatOrigen = msg.key.remoteJid || '';
      const esMiLid = msg.key.fromMe && chatOrigen.endsWith('@lid');
      const esApiNum = chatOrigen === `${NUMERO_API_LIMPIO}@s.whatsapp.net`;

      if (!esMiLid && !esApiNum) continue;

      console.log(`📨 Mensaje aceptado de: ${chatOrigen}`);

      // --- TEXTO ---
      const textoMsg = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || '';

      if (textoMsg.trim()) {
        await guardarEnBuzon(textoMsg, 'texto');
        continue;
      }

      // --- AUDIO ---
      if (msg.message?.audioMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const base64 = buffer.toString('base64');
          const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
          await guardarEnBuzon('[Audio recibido]', 'audio', {
            audioBase64: base64,
            mimeType,
            duracion: msg.message.audioMessage.seconds || 0
          });
        } catch (e) {
          console.error('Error descargando audio:', e.message);
          await guardarEnBuzon('[Audio - error al descargar]', 'audio_error');
        }
        continue;
      }

      // --- IMAGEN ---
      if (msg.message?.imageMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const base64 = buffer.toString('base64');
          const caption = msg.message.imageMessage.caption || '';
          await guardarEnBuzon(caption || '[Imagen recibida]', 'imagen', {
            imagenBase64: base64,
            mimeType: 'image/jpeg'
          });
        } catch (e) {
          console.error('Error descargando imagen:', e.message);
          await guardarEnBuzon('[Imagen - error al descargar]', 'imagen_error');
        }
        continue;
      }

      // --- DOCUMENTO / PDF ---
      if (msg.message?.documentMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const base64 = buffer.toString('base64');
          const fileName = msg.message.documentMessage.fileName || 'documento';
          const mimeType = msg.message.documentMessage.mimetype || 'application/pdf';
          await guardarEnBuzon(`[Documento: ${fileName}]`, 'documento', {
            documentoBase64: base64,
            mimeType,
            fileName
          });
        } catch (e) {
          console.error('Error descargando documento:', e.message);
          await guardarEnBuzon('[Documento - error al descargar]', 'documento_error');
        }
        continue;
      }
    }
  });
}

// =========================================================================
// 7. CRON — REPORTE DIARIO
// =========================================================================
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Ejecutando reporte diario...');
  if (!globalSock || !isConnected || !db) {
    console.log('⚠️ Bot no conectado o Firebase no disponible. Omitiendo cron.');
    return;
  }

  try {
    const snap = await db.collection('tasks')
      .where('room', '==', ROOM_CODE)
      .where('done', '==', false)
      .get();

    const pendientes = snap.docs.map(d => d.data());

    const ahora = new Date();
    const hora = ahora.toLocaleTimeString('es-PE', { hour12: false });
    const fecha = ahora.toLocaleDateString('es-PE');

    const mensaje = pendientes.length === 0
      ? `✅ A las ${hora} del ${fecha}, no hay tareas pendientes en ${ROOM_CODE}.`
      : `📋 A las ${hora} del ${fecha}, Los pendientes son:\n\n` +
        pendientes.map((t, i) => `${i + 1}. ${t.tarea || t.titulo || 'Sin título'}${t.responsable ? ` — ${t.responsable}` : ''}`).join('\n');

    for (const dest of DESTINATARIOS_CRON) {
      await globalSock.sendMessage(dest, { text: mensaje });
      console.log(`✅ Reporte enviado a ${dest}`);
    }
  } catch (e) {
    console.error('❌ Error en cron:', e.message);
  }
}, { timezone: 'America/Lima' });

// =========================================================================
// 8. ARRANCAR BOT
// =========================================================================
startBot().catch(console.error);
