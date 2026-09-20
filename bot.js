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

// El cron NO fija destinatarios ni hora.
// Ambos datos se leen desde settings/report_settings_<ROOM_CODE> guardado por index.html.

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
  // Solo mensajes nuevos en tiempo real. No procesamos sincronización histórica.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') {
      console.log(`⏩ Evento WhatsApp ignorado (type=${type}): no es un mensaje nuevo en tiempo real.`);
      return;
    }

    for (const msg of messages) {
      if (!msg?.key) continue;

      // No aceptar chats de grupos, estados ni broadcasts.
      const remote = String(msg.key.remoteJid || '');
      const remoteAlt = String(msg.key.remoteJidAlt || '');
      const candidates = [remote, remoteAlt].filter(Boolean);

      // Desenvolver mensaje si viene como temporal, vista única o documento con caption.
      let m = msg.message;
      if (m?.ephemeralMessage) m = m.ephemeralMessage.message;
      if (m?.viewOnceMessage) m = m.viewOnceMessage.message;
      if (m?.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
      if (m?.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
      if (!m) {
        console.log(`⏩ Mensaje sin contenido descifrable ignorado: ${remote}`);
        continue;
      }

      // Identidad de TU cuenta: PN y LID.
      // Importante: NO se usa fromMe para autorizar. fromMe no distingue por sí solo
      // entre tu chat contigo misma y un mensaje que tú envías a un tercero.
      const ownPn = String(sock.user?.id || '').split(':')[0].replace(/\D/g, '');
      const ownLid = String(sock.user?.lid || '').split(':')[0].replace(/\D/g, '');
      const ownPnCred = String((state?.creds?.me?.id) || '').split(':')[0].replace(/\D/g, '');
      const ownLidCred = String((state?.creds?.me?.lid) || '').split(':')[0].replace(/\D/g, '');

      const ownNumbers = new Set([ownPn, ownLid, ownPnCred, ownLidCred].filter(Boolean));
      const apiNumber = NUMERO_API_LIMPIO.replace(/\D/g, '');

      const jidUser = (jid) => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
      const isPrivateJid = (jid) => /@(s\.whatsapp\.net|lid)$/i.test(String(jid));

      // A) Solo tu propio chat: remoteJid o remoteJidAlt debe ser EXACTAMENTE
      // tu PN o tu LID, y además ser un chat 1:1.
      const esConmigoMisma = candidates.some(jid =>
        isPrivateJid(jid) && ownNumbers.has(jidUser(jid))
      );

      // B) Solo el chat con el número de API configurado.
      const esConApi = Boolean(apiNumber) && candidates.some(jid =>
        isPrivateJid(jid) && jidUser(jid) === apiNumber
      );

      // ⛔ Todo tercero queda fuera. No hay excepción por fromMe.
      if (!esConmigoMisma && !esConApi) {
        console.log(`⛔ PRIVACIDAD — ignorado: remote=${remote} alt=${remoteAlt} fromMe=${Boolean(msg.key.fromMe)}`);
        continue;
      }

      const origen = esConmigoMisma ? 'CHAT_PROPIO' : 'CHAT_API';
      console.log(`📩 AUTORIZADO [${origen}] remote=${remote} alt=${remoteAlt}`);

      const sender = msg.pushName || (esConmigoMisma ? 'Yo (WhatsApp)' : 'WhatsApp API');
      let text = m.conversation || m.extendedTextMessage?.text || '';
      let attachments = [];

      // Audio / nota de voz
      if (m.audioMessage) {
        console.log('🎙️ Audio detectado. Descargando...');
        try {
          const buffer = await downloadMediaMessage({ ...msg, message: m }, 'buffer', {});
          if (buffer && buffer.length) {
            attachments.push({
              name: `audio_${Date.now()}.ogg`,
              type: 'audio/ogg',
              size: buffer.length,
              base64: buffer.toString('base64')
            });
          }
          if (!text) text = '[Nota de voz reenviada desde WhatsApp]';
        } catch (err) {
          console.error('Error descargando audio:', err.message);
        }
      }

      // Imagen / PDF / documento
      if (m.imageMessage || m.documentMessage) {
        try {
          const isImg = !!m.imageMessage;
          const buffer = await downloadMediaMessage({ ...msg, message: m }, 'buffer', {});
          if (buffer && buffer.length) {
            const mime = isImg ? 'image/jpeg' : (m.documentMessage?.mimetype || 'application/pdf');
            const fileName = isImg ? `img_${Date.now()}.jpg` : (m.documentMessage?.fileName || 'documento.pdf');
            attachments.push({
              name: fileName,
              type: mime,
              size: buffer.length,
              base64: buffer.toString('base64')
            });
            if (!text) text = `[Archivo adjunto: ${fileName}]`;
          }
        } catch (err) {
          console.error('Error descargando archivo:', err.message);
        }
      }

      if (text || attachments.length) {
        try {
          // ÚNICA persistencia del bot: Buzón.
          // No se crea ni actualiza whatsappHistory.
          await db.collection('inbox').add({
            room: ROOM_CODE,
            sender,
            text,
            attachments,
            timestamp: Date.now(),
            source: origen
          });

          console.log(`✅ ¡ÉXITO! Mensaje guardado SOLO en el Buzón de la sala ${ROOM_CODE}.`);
        } catch (dbErr) {
          console.error('Error en Firebase al guardar Buzón:', dbErr.message);
        }
      }
    }
  });

  // =========================================================================
  // 5. CRON DINÁMICO: LEER SIEMPRE LA CONFIGURACIÓN DEL INDEX
  // =========================================================================
  let ultimaFechaEjecutada = '';

  // El proceso consulta cada minuto. La hora NO está fija aquí:
  // se toma de settings/report_settings_<ROOM_CODE>.
  cron.schedule('* * * * *', async () => {
    try {
      if (!db || !globalSock || !isConnected) return;

      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Lima',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).formatToParts(now);

      const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
      const horaActualLocal = `${p.hour}:${p.minute}`;
      const fechaActualLocal = `${p.year}-${p.month}-${p.day}`;

      const cfgRef = db.collection('settings').doc(`report_settings_${ROOM_CODE}`);
      const cfgSnap = await cfgRef.get();

      if (!cfgSnap.exists) {
        console.log(`⏩ Cron: no existe report_settings_${ROOM_CODE}; no se envía nada.`);
        return;
      }

      const cfg = cfgSnap.data() || {};
      const horaObjetivo = String(cfg.scheduleTime || '').slice(0, 5);
      const telefonoK = String(cfg.phoneK || '').replace(/\D/g, '');
      const telefonoO = String(cfg.phoneO || '').replace(/\D/g, '');

      if (!/^\d{2}:\d{2}$/.test(horaObjetivo)) {
        console.log('⏩ Cron: scheduleTime no configurada correctamente en index.html.');
        return;
      }

      if (horaActualLocal !== horaObjetivo) return;

      if (ultimaFechaEjecutada === fechaActualLocal) {
        console.log(`⏩ Cron: reporte ya ejecutado hoy (${fechaActualLocal}).`);
        return;
      }

      console.log(`⏰ CRON — hora configurada en index.html: ${horaObjetivo}. Preparando envío...`);

      const destinatarios = [
        ['K', telefonoK],
        ['O', telefonoO]
      ].filter(([, phone]) => phone);

      if (!destinatarios.length) {
        console.log('⏩ Cron: no hay teléfonos K/O configurados en index.html.');
        return;
      }

      const snap = await db.collection('tasks')
        .where('room', '==', ROOM_CODE)
        .where('done', '==', false)
        .where('status', '==', 'active')
        .get();

      if (snap.empty) {
        console.log('⏩ Cron: no hay pendientes para enviar.');
        ultimaFechaEjecutada = fechaActualLocal;
        return;
      }

      const grupos = {};
      snap.forEach(d => {
        const t = d.data() || {};
        const person = t.assignee || 'General';
        (grupos[person] ||= []).push(t);
      });

      let report = `A las ${p.hour}:${p.minute}:${p.second} del ${Number(p.day)}/${Number(p.month)}/${p.year},\n\nLos pendientes son:\n\n`;

      for (const [person, items] of Object.entries(grupos)) {
        report += `👤 ${person}\n\n`;
        items.forEach((t, i) => {
          report += `${i + 1}. ${t.title}\n\n`;
        });
      }

      let enviados = 0;
      for (const [label, phone] of destinatarios) {
        try {
          await globalSock.sendMessage(`${phone}@s.whatsapp.net`, { text: report.trimEnd() });
          enviados++;
          console.log(`✅ Cron: reporte enviado a ${label} (${phone}).`);
        } catch (sendErr) {
          console.error(`❌ Cron: error enviando a ${label}:`, sendErr.message);
        }
      }

      // Solo marcamos el día como ejecutado si al menos un destinatario recibió el envío.
      if (enviados > 0) {
        ultimaFechaEjecutada = fechaActualLocal;
        console.log(`✅ Cron finalizado: ${enviados}/${destinatarios.length} destinatario(s).`);
      } else {
        console.log('⚠️ Cron: fallaron todos los envíos; podrá volver a intentarse dentro del mismo minuto.');
      }
    } catch (e) {
      console.error('❌ Error en cron dinámico:', e.message);
    }
  });
}

startBot();
