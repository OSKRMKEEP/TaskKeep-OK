const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// =========================================================================
// ⚙️ CONFIGURACIÓN DE TU SALA Y DESTINATARIOS
// =========================================================================
const ROOM_CODE = process.env.ROOM_CODE || 'FACEX';

// Teléfonos para el reporte de las 9:00 AM
const DESTINATARIOS_CRON = [
  '51952507450@s.whatsapp.net', // Destinatario 1 (K)
  '51952507450@s.whatsapp.net'  // Destinatario 2 (O)
];

// Si tienes el número de tu API de WhatsApp, pon solo los números sin signos ni arrobas
const NUMERO_API_LIMPIO = '15556741749'; // Reemplaza por los dígitos de tu API

// =========================================================================
// 1. SERVIDOR WEB EXPRESS (MANTIENE VIVO RENDER)
// =========================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let lastQrSvg = null;
let isConnected = false;

app.get('/', (req, res) => {
  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>🟢 TaskKeep WhatsApp Bot</h2>
      <p>Estado WhatsApp: <b>${isConnected ? '✅ Conectado y escuchando' : '⏳ Esperando escaneo de QR'}</b></p>
      <p>Sala activa: <b>${ROOM_CODE}</b></p>
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
      <img src="${lastQrSvg}" style="border:1px solid #ccc;padding:10px;border-radius:12px;max-width:300px"/>
    </div>
  `);
});

app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));

// =========================================================================
// 2. CONEXIÓN A FIREBASE ADMIN
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
// 3. PERSISTENCIA DE SESIÓN EN FIRESTORE
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
// 4. LÓGICA PRINCIPAL DE WHATSAPP Y PROCESAMIENTO
// =========================================================================
async function startBot() {
  if (!db) {
    console.log('⏳ Esperando credenciales de Firebase para iniciar...');
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
      console.log('📲 Código QR disponible en /qr');
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      lastQrSvg = null;
      console.log('🟢 WhatsApp conectado exitosamente.');
    }
  });

  // ESCUCHAR MENSAJES ENTRANTES CON DIAGNÓSTICO TOTAL
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message) return;

    const chatOrigen = msg.key.remoteJid || '';
    const esGrupo = chatOrigen.endsWith('@g.us');
    const miNumero = sock.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
    const chatLimpio = chatOrigen.replace(/\D/g, '');

    // Diagnóstico en consola de Render (Verás esto en vivo)
    console.log(`📩 Mensaje entrante. Origen: [${chatOrigen}] | ¿Es grupo?: ${esGrupo}`);

    // DETERMINAR SI DEBE PROCESARSE:
    // 1. Es un grupo donde está el bot
    // 2. Es un mensaje enviado a tu propio chat ("Tú")
    // 3. Es un mensaje hacia/desde el número de tu API
    const esChatPropio = miNumero && chatLimpio.includes(miNumero);
    const esChatApi = NUMERO_API_LIMPIO && chatLimpio.includes(NUMERO_API_LIMPIO);

    if (!esGrupo && !esChatPropio && !esChatApi) {
      console.log(`⏩ Mensaje ignorado por política de privacidad (Chat personal ajeno: ${chatOrigen})`);
      return;
    }

    console.log('⚡ Procesando mensaje de trabajo para el Buzón...');

    // OBTENER EL REMITENTE REAL:
    // Si es grupo, WhatsApp nos da 'participant' (el teléfono del integrante que habló)
    const emisorJid = esGrupo ? (msg.key.participant || '') : chatOrigen;
    const telefonoEmisor = emisorJid.replace(/\D/g, '');
    const pushName = msg.pushName || 'Miembro del equipo';

    let nombreOficial = pushName;

    // Buscar en el Directorio de Firebase si este teléfono tiene un nombre asignado
    if (telefonoEmisor) {
      try {
        const snapCont = await db.collection('contacts').where('room', '==', ROOM_CODE).get();
        snapCont.forEach(doc => {
          const c = doc.data();
          const telContact = String(c.phone || '').replace(/\D/g, '');
          if (telContact && telefonoEmisor.includes(telContact)) {
            nombreOficial = c.name;
          }
        });
      } catch (e) {
        console.warn('Aviso leyendo directorio:', e.message);
      }
    }

    // EXTRAER EL CONTENIDO (TEXTO, AUDIO, IMAGEN O PDF)
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    let attachments = [];

    // SI ES NOTA DE VOZ O AUDIO (.OGG)
    const audioMsg = msg.message.audioMessage;
    if (audioMsg) {
      console.log(`🎙️ Descargando audio de ${nombreOficial}...`);
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        attachments.push({
          name: `audio_${Date.now()}.ogg`,
          type: 'audio/ogg',
          size: buffer.length,
          base64: buffer.toString('base64')
        });
        if (!text) text = `[Audio de WhatsApp enviado por ${nombreOficial}]`;
      } catch (err) {
        console.error('Error descargando audio:', err.message);
      }
    }

    // SI ES IMAGEN O DOCUMENTO PDF
    if (msg.message.imageMessage || msg.message.documentMessage) {
      try {
        const isImg = !!msg.message.imageMessage;
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const mime = isImg ? 'image/jpeg' : (msg.message.documentMessage?.mimetype || 'application/pdf');
        const fileName = isImg ? `img_${Date.now()}.jpg` : (msg.message.documentMessage?.fileName || 'documento.pdf');
        attachments.push({
          name: fileName,
          type: mime,
          size: buffer.length,
          base64: buffer.toString('base64')
        });
        if (!text) text = `[Archivo adjunto: ${fileName}]`;
      } catch (err) {
        console.error('Error descargando adjunto:', err.message);
      }
    }

    if (!text && !attachments.length) return;

    // GUARDAR EN EL BUZÓN DE FIREBASE
    try {
      await db.collection('inbox').add({
        room: ROOM_CODE,
        sender: nombreOficial,
        text: text,
        attachments: attachments,
        timestamp: Date.now()
      });

      // Guardar también en el Historial de WhatsApp de la sala
      await db.collection('whatsappHistory').add({
        room: ROOM_CODE,
        sender: nombreOficial,
        text: text,
        importedAt: Date.now(),
        sourceFile: esGrupo ? 'Grupo de WhatsApp' : 'Chat WhatsApp'
      });

      console.log(`✅ ¡ÉXITO! Mensaje de ${nombreOficial} guardado en el Buzón de la sala ${ROOM_CODE}.`);
    } catch (dbErr) {
      console.error('❌ Error escribiendo en Firestore:', dbErr.message);
    }
  });

  // =========================================================================
  // 5. CRON DIARIO AUTOMÁTICO (TODOS LOS DÍAS A LAS 09:00 AM)
  // =========================================================================
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Ejecutando cron diario a las 09:00 AM...');
    try {
      const snap = await db.collection('tasks')
        .where('room', '==', ROOM_CODE)
        .where('done', '==', false)
        .where('status', '==', 'active')
        .get();

      if (snap.empty) {
        console.log('No hay pendientes para hoy.');
        return;
      }

      let report = '*📋 Buen día, este es el reporte de tareas pendientes para hoy:*\n\n';
      snap.forEach(d => {
        const t = d.data();
        report += `• *[${t.assignee || 'General'}]:* ${t.title}\n`;
      });
      report += '\n_Quedamos al pendiente._';

      for (const jid of DESTINATARIOS_CRON) {
        await sock.sendMessage(jid, { text: report });
      }
      console.log('✅ Reporte cron enviado con éxito a los destinatarios.');
    } catch (e) {
      console.error('Error en cron:', e.message);
    }
  });
}

startBot();
