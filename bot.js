const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// --- 1. CONFIGURACIÓN DEL SERVIDOR WEB (OBLIGATORIO PARA RENDER) ---
const app = express();
const PORT = process.env.PORT || 3000;
let lastQrSvg = null;
let isConnected = false;

app.get('/', (req, res) => {
  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>🟢 TaskKeep WhatsApp Bot</h2>
      <p>Estado de WhatsApp: <b>${isConnected ? '✅ Conectado y escuchando' : '⏳ Esperando escaneo de QR'}</b></p>
      ${!isConnected ? '<p><a href="/qr" style="background:#0f9d73;color:white;padding:10px 16px;border-radius:8px;text-decoration:none">Ver Código QR para escanear</a></p>' : ''}
    </div>
  `);
});

// Ruta para UptimeRobot (Mantiene vivo el servidor 24/7)
app.get('/ping', (req, res) => res.status(200).send('pong'));

// Ruta para ver el código QR desde el navegador
app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<h3>✅ WhatsApp ya está vinculado y conectado.</h3>');
  if (!lastQrSvg) return res.send('<h3>Generando código QR... recarga en unos segundos.</h3>');
  res.send(`
    <div style="text-align:center;padding:30px;font-family:sans-serif">
      <h2>Escanea este QR con WhatsApp</h2>
      <p>Ve a WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
      <img src="${lastQrSvg}" style="border:1px solid #ccc;padding:10px;border-radius:12px;max-width:300px"/>
      <p style="font-size:12px;color:gray">Esta página se actualiza sola al vincularse.</p>
    </div>
  `);
});

app.listen(PORT, () => console.log(`🚀 Servidor web activo en puerto ${PORT}`));

// --- 2. INICIALIZAR FIREBASE ADMIN ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('Error parseando FIREBASE_SERVICE_ACCOUNT:', e.message);
  }
} else if (fs.existsSync('./firebase-key.json')) {
  serviceAccount = require('./firebase-key.json');
}

if (!serviceAccount) {
  console.error('❌ Falta configurar la credencial de Firebase (variable FIREBASE_SERVICE_ACCOUNT en Render).');
} else {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const ROOM_CODE = process.env.ROOM_CODE || 'EQUIPO1'; // Cambia por el nombre de tu sala

// --- 3. INICIALIZAR GEMINI ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- 4. PERSISTENCIA DE SESIÓN EN FIRESTORE (EVITA VOLVER A ESCANEAR EN REINICIOS) ---
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
    console.warn('Aviso al restaurar sesión:', e.message);
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
  } catch (e) {
    // sincronización en segundo plano
  }
}

// --- 5. LÓGICA PRINCIPAL DE BAILEYS ---
async function startBot() {
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
      console.log('📲 Nuevo código QR generado. Ábrelo en https://tu-app.onrender.com/qr');
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      lastQrSvg = null;
      console.log('🟢 WhatsApp conectado exitosamente.');
    }
  });

  // ESCUCHAR MENSAJES Y AUDIOS DE WHATSAPP
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.pushName || 'WhatsApp';
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    // Si es un audio o nota de voz (.ogg)
    if (msg.message.audioMessage) {
      console.log(`🎙️ Nota de voz recibida de ${sender}. Procesando con Gemini...`);
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const response = await ai.models.generateContent({
          model: 'gemini-1.5-flash',
          contents: [
            { text: 'Analiza este audio y extrae las tareas pendientes o compromisos en texto claro:' },
            { inlineData: { mimeType: 'audio/ogg', data: buffer.toString('base64') } }
          ]
        });
        text = `[Transcripción Nota de Voz]: ${response.text}`;
      } catch (err) {
        console.error('Error procesando audio con Gemini:', err.message);
        text = '[Audio recibido - Error al transcribir]';
      }
    }

    if (text) {
      // Guardar directamente en el Buzón de la Sala en Firestore
      await db.collection('inbox').add({
        room: ROOM_CODE,
        sender: sender,
        text: text,
        timestamp: Date.now()
      });
      console.log(`✅ Mensaje de ${sender} añadido al buzón de la sala ${ROOM_CODE}.`);
    }
  });

  // CRON DIARIO AUTOMÁTICO (09:00 AM)
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Ejecutando cron automático de tareas pendientes...');
    try {
      const snap = await db.collection('tasks')
        .where('room', '==', ROOM_CODE)
        .where('done', '==', false)
        .where('status', '==', 'active')
        .get();

      if (snap.empty) {
        console.log('Sin tareas pendientes para enviar hoy.');
        return;
      }

      let report = '*📋 Buen día, este es el reporte de tareas pendientes para hoy:*\n\n';
      snap.forEach(d => {
        const t = d.data();
        report += `• *[${t.assignee || 'General'}]:* ${t.title}\n`;
      });
      report += '\n_Quedamos al pendiente._';

      // Reemplaza con los números que deben recibir el reporte
      const destinatarios = [
        '51987654321@s.whatsapp.net', // Teléfono de K
        '51912345678@s.whatsapp.net'  // Teléfono de O
      ];

      for (const jid of destinatarios) {
        await sock.sendMessage(jid, { text: report });
      }
      console.log('✅ Reporte cron enviado con éxito.');
    } catch (e) {
      console.error('Error enviando reporte cron:', e.message);
    }
  });
}
startBot();
