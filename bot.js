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
const DESTINATARIOS_CRON = [
  '51952507450@s.whatsapp.net', // Destinatario 1
  '51952507450@s.whatsapp.net'  // Destinatario 2
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

      // 2. OBTENER IDENTIFICADORES PROPIOS, COMPARANDO EL JID COMPLETO (no por coincidencia parcial)
      // normalizeJid quita el sufijo de dispositivo (":12") que WhatsApp agrega a TU propio id,
      // para poder comparar JIDs completos en igualdad estricta (===) y no por "contiene".
      const normalizeJid = (jid) => (jid ? jid.replace(/:\d+@/, '@') : '');

      const miJidNumero = normalizeJid(sock.user?.id);   // ej: 51999999999@s.whatsapp.net
      const miJidLid = normalizeJid(sock.user?.lid);      // ej: 123456789@lid
      const chatNorm = normalizeJid(chatOrigen);

      // 🛡️ REGLA DE PRIVACIDAD ESTRICTA:
      // A) ¿Es tu chat "Tú" (contigo misma)? SOLO si el JID del chat es EXACTAMENTE tu propio JID
      //    (la versión numérica o la versión @lid). Ya NO se usa "fromMe && endsWith('@lid')",
      //    porque esa condición también es verdadera cuando le escribes a CUALQUIER contacto que
      //    WhatsApp te muestre con formato @lid (su función de privacidad de número), y por eso
      //    se estaban copiando mensajes que le mandabas a otras personas.
      const esConmigoMisma = Boolean(
        (miJidNumero && chatNorm === miJidNumero) ||
        (miJidLid && chatNorm === miJidLid)
      );

      // B) ¿Es el chat con el número de tu API? Comparación EXACTA de dígitos (no "includes"),
      //    para evitar falsos positivos si el número de algún contacto contuviera esos mismos dígitos.
      const chatDigits = chatOrigen.split('@')[0].replace(/\D/g, '');
      const apiDigits = NUMERO_API_LIMPIO.replace(/\D/g, '');
      const esConApi = Boolean(apiDigits && chatDigits === apiDigits);

      // ⛔ SI NO ES TU CHAT PRIVADO CONTIGO MISMA NI CON LA API, SE IGNORA
      // (esto incluye TODO lo que le envíes a otras personas, que es justo lo que no quieres copiar)
      if (!esConmigoMisma && !esConApi) {
        console.log(`⏩ Mensaje ignorado por privacidad (No es chat propio ni API: ${chatOrigen})`);
        continue;
      }

      console.log(`📩 Mensaje de trabajo autorizado detectado en [${chatOrigen}]. Procesando...`);

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

          // 2. Guardar en el historial permanente de WhatsApp
          await db.collection('whatsappHistory').add({
            room: ROOM_CODE,
            sender: sender,
            text: text,
            importedAt: Date.now(),
            sourceFile: esConmigoMisma ? 'Chat conmigo misma' : 'Chat API'
          });

          console.log(`✅ ¡ÉXITO! Mensaje guardado en el Buzón de la sala ${ROOM_CODE}.`);
        } catch (dbErr) {
          console.error('Error en Firebase:', dbErr.message);
        }
      }
    }
  });

  // =========================================================================
  // 5. CRON DINÁMICO INTELIGENTE (SINCRONIZADO CON TU PÁGINA WEB)
  // =========================================================================
  let ultimaFechaEjecutada = '';

  // Revisa cada minuto si ya llegó la hora que pusiste en la web
  cron.schedule('* * * * *', async () => {
    try {
      // 1. Obtener la hora actual en tu zona horaria local (Perú/Colombia/Ecuador)
      const ahora = new Date();
      const opcionesHora = { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false };
      const horaActualLocal = new Intl.DateTimeFormat('es-PE', opcionesHora).format(ahora);
      const fechaActualLocal = ahora.toISOString().slice(0, 10);

      // 2. Leer la hora que configuraste en tu página web desde Firebase.
      //    OJO: esto se ejecuta cada minuto (por el cron.schedule('* * * * *')) y SIEMPRE
      //    vuelve a leer el documento de Firestore, así que si cambias la hora en TaskKeep,
      //    el bot la detecta solo, en el siguiente minuto, sin que reinicies nada.
      let horaObjetivo = '09:00'; // Por defecto 9:00 AM si aún no configuraste nada en TaskKeep
      const docConfig = await db.collection('settings').doc('report_settings_' + ROOM_CODE).get();
      if (docConfig.exists && docConfig.data().scheduleTime) {
        horaObjetivo = String(docConfig.data().scheduleTime).trim();
        // Normaliza por si TaskKeep llegara a guardar "9:00" en vez de "09:00"
        const [h, mnt] = horaObjetivo.split(':');
        if (h && mnt) horaObjetivo = `${h.padStart(2, '0')}:${mnt.padStart(2, '0')}`;
      }

      // 3. Si la hora actual coincide con la hora configurada en TaskKeep y no se ha enviado hoy:
      if (horaActualLocal === horaObjetivo && ultimaFechaEjecutada !== fechaActualLocal) {
        console.log(`⏰ ¡Son las ${horaActualLocal}! Disparando reporte automático sincronizado...`);
        ultimaFechaEjecutada = fechaActualLocal;

        const snap = await db.collection('tasks')
          .where('room', '==', ROOM_CODE)
          .where('done', '==', false)
          .where('status', '==', 'active')
          .get();

        if (snap.empty) {
          console.log('No hay pendientes para enviar hoy.');
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
        console.log('✅ Reporte cron enviado con éxito a la hora programada.');
      }
    } catch (e) {
      console.error('Error en cron dinámico:', e.message);
    }
  });
}

startBot();
