const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// =========================================================================
// ⚙️ DATOS QUE DEBES PERSONALIZAR (SOLO ESTOS 3)
// =========================================================================

// [EDITAR AQUÍ 1]: Nombre exacto de tu sala en TaskKeep (ej: 'EQUIPO1' o 'OFICINA')
const ROOM_CODE = process.env.ROOM_CODE || 'FACEX';

// [EDITAR AQUÍ 2]: El número de tu API de WhatsApp al que le vas a reenviar los mensajes
// Formato: Código de país + número + @s.whatsapp.net (ejemplo Perú: 51 + 911222333 + @s.whatsapp.net)
const NUMERO_API_WHATSAPP = '15556741749@s.whatsapp.net';

// [EDITAR AQUÍ 3]: Los dos teléfonos que recibirán el reporte diario de las 9:00 AM
const DESTINATARIOS_CRON = [
  '51952507450@s.whatsapp.net', // Teléfono de Persona 1 (K)
  '51939486621@s.whatsapp.net'  // Teléfono de Persona 2 (O)
];

// =========================================================================
// 1. SERVIDOR WEB (OBLIGATORIO PARA RENDER Y UPTIMEROBOT)
// =========================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let lastQrSvg = null;
let isConnected = false;

app.get('/', (req, res) => {
  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>🟢 TaskKeep WhatsApp Bot & Cron</h2>
      <p>Estado WhatsApp: <b>${isConnected ? '✅ Conectado y escuchando' : '⏳ Esperando escaneo de QR'}</b></p>
      <p>Sala conectada: <b>${ROOM_CODE}</b></p>
      ${!isConnected ? '<p><a href="/qr" style="background:#0f9d73;color:white;padding:10px 16px;border-radius:8px;text-decoration:none">Ver Código QR</a></p>' : ''}
    </div>
  `);
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<h3>✅ WhatsApp ya está vinculado y funcionando.</h3>');
  if (!lastQrSvg) return res.send('<h3>Generando código QR... recarga en unos segundos.</h3>');
  res.send(`
    <div style="text-align:center;padding:30px;font-family:sans-serif">
      <h2>Escanea este QR con WhatsApp</h2>
      <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
      <img src="${lastQrSvg}" style="border:1px solid #ccc;padding:10px;border-radius:12px;max-width:300px"/>
    </div>
  `);
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
} else if (fs.existsSync('./firebase-key.json')) {
  serviceAccount = require('./firebase-key.json');
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
// 3. PERSISTENCIA DE SESIÓN (NO VOLVER A ESCANEAR QR SI RENDER REINICIA)
// =========================================================================
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

async function restoreSessionFromFirestore() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const snap = await db.collection('bot_auth').get();
    for (const doc of snap.docs) {
      const filename = doc.id.replace(/___/g, ':').replace(/__/g, '-');
      fs.writeFileSync(path.join(AUTH_DIR, filename), doc.data().content, 'utf8');
    }
    console.log('📦 Sesión restaurada desde Firestore.');
  } catch (e) {
    console.warn('Nota de sesión:', e.message);
  }
}

async function syncSessionToFirestore() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const files = fs.readdirSync(AUTH_DIR);
    for (const file of files) {
      const content = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
      const docId = file.replace(/:/g, '___').replace(/-/g, '__');
      await db.collection('bot_auth').doc(docId).set({ content, updatedAt: Date.now() });
    }
  } catch (e) {}
}

// =========================================================================
// 4. LÓGICA DE WHATSAPP: REENVIAR Y GUARDAR EN BUZÓN (CERO GASTO DE TOKENS)
// =========================================================================
async function startBot() {
  if (!db) {
    console.log('⏳ Esperando credenciales de Firebase para iniciar WhatsApp...');
    return;
  }

  await restoreSessionFromFirestore();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await syncSessionToFirestore();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      lastQrSvg = await qrcode.toDataURL(qr);
      console.log('📲 Código QR disponible en la ruta /qr');
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      lastQrSvg = null;
      console.log('🟢 WhatsApp conectado y listo.');
    }
  });

  // ESCUCHAR LO QUE REENVÍES
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const chatOrigen = msg.key.remoteJid;
    const miPropioJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

    // 🔒 FILTRO: Solo procesar si te lo reenvías a ti misma ("Tú") o al número de tu API
    const esParaMi = (chatOrigen === miPropioJid);
    const esParaApi = (chatOrigen === NUMERO_API_WHATSAPP);

    if (!esParaMi && !esParaApi) {
      return; // Ignorar chats personales, familiares y grupos
    }

    console.log('📨 Mensaje de trabajo recibido. Guardando en Buzón...');
    const sender = msg.pushName || 'WhatsApp';
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    let attachments = [];

    // SI ES UN AUDIO (.OGG)
    if (msg.message.audioMessage) {
      console.log('🎙️ Audio recibido. Descargando para el buzón...');
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        attachments.push({
          name: `audio_${Date.now()}.ogg`,
          type: 'audio/ogg',
          size: buffer.length,
          base64: buffer.toString('base64')
        });
        if (!text) text = '[Nota de voz de WhatsApp]';
      } catch (err) {
        console.error('Error descargando audio:', err.message);
      }
    }

    // SI ES UNA IMAGEN O DOCUMENTO PDF
    if (msg.message.imageMessage || msg.message.documentMessage) {
      try {
        const isImg = !!msg.message.imageMessage;
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const mime = isImg ? 'image/jpeg' : (msg.message.documentMessage?.mimetype || 'application/pdf');
        const fileName = isImg ? `imagen_${Date.now()}.jpg` : (msg.message.documentMessage?.fileName || 'documento.pdf');
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
      // 1. Guardar en el Historial permanente de WhatsApp
      await db.collection('whatsappHistory').add({
        room: ROOM_CODE,
        sender: sender,
        text: text,
        importedAt: Date.now(),
        sourceFile: 'Reenviado desde WhatsApp'
      });

      // 2. Guardar en el Buzón de la sala (sin gastar tokens de IA)
      await db.collection('inbox').add({
        room: ROOM_CODE,
        sender: sender,
        text: text,
        attachments: attachments,
        timestamp: Date.now()
      });

      console.log(`✅ Mensaje guardado en el Buzón de la sala ${ROOM_CODE}.`);
    }
  });

  // =========================================================================
  // 5. CRON DIARIO AUTOMÁTICO (TODOS LOS DÍAS A LAS 09:00 AM)
  // =========================================================================
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Disparando reporte cron de las 09:00 AM...');
    try {
      const snap = await db.collection('tasks')
        .where('room', '==', ROOM_CODE)
        .where('done', '==', false)
        .where('status', '==', 'active')
        .get();

      if (snap.empty) {
        console.log('No hay tareas pendientes para hoy.');
        return;
      }

      let report = '*📋 Buen día, este es el reporte de tareas pendientes para hoy:*\n\n';
      snap.forEach(d => {
        const t = d.data();
        report += `• *[${t.assignee || 'General'}]:* ${t.title}\n`;
      });
      report += '\n_Quedamos al pendiente._';

      // Enviar a los dos números configurados
      for (const jid of DESTINATARIOS_CRON) {
        await sock.sendMessage(jid, { text: report });
      }
      console.log('✅ Reporte enviado exitosamente a ambos destinatarios.');
    } catch (e) {
      console.error('Error enviando cron:', e.message);
    }
  });
}

startBot();
