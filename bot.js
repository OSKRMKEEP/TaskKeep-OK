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

// El cron NO fija una hora ni destinatarios.
// Ambos datos se leen dinámicamente desde:
// settings/report_settings_<ROOM_CODE>, guardado por index.html.

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
  //
  // PRIVACIDAD:
  // - Solo se procesan mensajes NUEVOS en tiempo real (type === 'notify').
  // - Solo se acepta tu chat contigo misma o el chat con el número de API.
  // - NUNCA se autoriza un tercero solo porque fromMe === true.
  // - NO se guarda whatsappHistory; únicamente se escribe en "inbox".

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') {
      console.log(`⏩ WhatsApp: evento ${type || 'sin tipo'} ignorado (no es mensaje nuevo).`);
      return;
    }

    for (const msg of messages || []) {
      if (!msg?.key) continue;

      const remoteJid = String(msg.key.remoteJid || '');
      const remoteJidAlt = String(msg.key.remoteJidAlt || '');
      const candidates = [remoteJid, remoteJidAlt].filter(Boolean);

      // Desenvolver mensaje si viene encapsulado.
      let m = msg.message;
      if (m?.ephemeralMessage) m = m.ephemeralMessage.message;
      if (m?.viewOnceMessage) m = m.viewOnceMessage.message;
      if (m?.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
      if (m?.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

      if (!m) continue;

      // Identidad de la cuenta conectada: PN y LID.
      const ownPn = String(sock.user?.id || state?.creds?.me?.id || '')
        .split(':')[0].split('@')[0].replace(/\D/g, '');
      const ownLid = String(sock.user?.lid || state?.creds?.me?.lid || '')
        .split(':')[0].split('@')[0].replace(/\D/g, '');

      const apiNumber = String(NUMERO_API_LIMPIO || '').replace(/\D/g, '');

      const jidUser = (jid) => String(jid)
        .split('@')[0]
        .split(':')[0]
        .replace(/\D/g, '');

      const isOneToOneJid = (jid) =>
        /@(s\.whatsapp\.net|lid)$/i.test(String(jid));

      // Tu chat contigo misma:
      // 1) JID coincide exactamente con tu PN/LID; o
      // 2) WhatsApp usa @lid + fromMe y remoteJidAlt coincide EXACTAMENTE
      //    con tu número PN. Este caso es necesario para self-chat moderno.
      const ownDirectJid = candidates.some((jid) =>
        isOneToOneJid(jid) &&
        [ownPn, ownLid].filter(Boolean).includes(jidUser(jid))
      );

      const ownSelfLidFromMe =
        Boolean(msg.key.fromMe) &&
        /@lid$/i.test(remoteJid) &&
        Boolean(ownPn) &&
        remoteJidAlt &&
        /@s\.whatsapp\.net$/i.test(remoteJidAlt) &&
        jidUser(remoteJidAlt) === ownPn;

      const esConmigoMisma = ownDirectJid || ownSelfLidFromMe;

      // Chat con el número de API, comparación EXACTA.
      const esConApi =
        Boolean(apiNumber) &&
        candidates.some((jid) =>
          isOneToOneJid(jid) && jidUser(jid) === apiNumber
        );

      // Todo tercero queda fuera.
      if (!esConmigoMisma && !esConApi) {
        console.log(
          `⛔ PRIVACIDAD — ignorado. remote=${remoteJid} alt=${remoteJidAlt} fromMe=${Boolean(msg.key.fromMe)}`
        );
        continue;
      }

      const origen = esConmigoMisma ? 'CHAT_PROPIO' : 'CHAT_API';
      console.log(`📩 AUTORIZADO [${origen}] — mensaje recibido.`);

      const sender = msg.pushName || (esConmigoMisma ? 'Yo (WhatsApp)' : 'WhatsApp API');
      let text = m.conversation || m.extendedTextMessage?.text || '';
      const attachments = [];

      // Audio / nota de voz.
      if (m.audioMessage) {
        console.log('🎙️ Audio autorizado detectado. Descargando...');
        try {
          const buffer = await downloadMediaMessage({ ...msg, message: m }, 'buffer', {});
          if (buffer?.length) {
            attachments.push({
              name: `audio_${Date.now()}.ogg`,
              type: 'audio/ogg',
              size: buffer.length,
              base64: buffer.toString('base64')
            });
          }
          if (!text) text = '[Nota de voz reenviada desde WhatsApp]';
        } catch (err) {
          console.error('❌ Error descargando audio:', err.message);
        }
      }

      // Imagen / PDF / documento.
      if (m.imageMessage || m.documentMessage) {
        try {
          const isImg = !!m.imageMessage;
          const buffer = await downloadMediaMessage({ ...msg, message: m }, 'buffer', {});
          if (buffer?.length) {
            const mime = isImg
              ? 'image/jpeg'
              : (m.documentMessage?.mimetype || 'application/pdf');
            const fileName = isImg
              ? `img_${Date.now()}.jpg`
              : (m.documentMessage?.fileName || 'documento.pdf');

            attachments.push({
              name: fileName,
              type: mime,
              size: buffer.length,
              base64: buffer.toString('base64')
            });

            if (!text) text = `[Archivo adjunto: ${fileName}]`;
          }
        } catch (err) {
          console.error('❌ Error descargando archivo:', err.message);
        }
      }

      if (text || attachments.length) {
        try {
          // ÚNICA persistencia del bot: Buzón.
          await db.collection('inbox').add({
            room: ROOM_CODE,
            sender,
            text,
            attachments,
            timestamp: Date.now()
          });

          console.log(`✅ Mensaje autorizado guardado SOLO en el Buzón de ${ROOM_CODE}.`);
        } catch (dbErr) {
          console.error('❌ Error en Firebase al guardar Buzón:', dbErr.message);
        }
      }
    }
  });
  // El resto de la lógica de WhatsApp termina aquí.
}

// -------------------------------------------------------------------------
// CRON ÚNICO GLOBAL
// -------------------------------------------------------------------------
let ultimaFechaEjecutada = '';

cron.schedule('* * * * *', async () => {
  try {
    if (!db || !globalSock || !isConnected) return;

    // Hora y fecha de Perú, sin depender del huso horario del servidor Render.
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(now);

    const p = Object.fromEntries(
      parts
        .filter(x => x.type !== 'literal')
        .map(x => [x.type, x.value])
    );

    // Node/ICU puede representar medianoche como "24"; normalizamos a "00".
    const hour = p.hour === '24' ? '00' : p.hour;
    const horaActualLocal = `${hour}:${p.minute}`;
    const fechaActualLocal = `${p.year}-${p.month}-${p.day}`;

    // LEER CONFIGURACIÓN GUARDADA POR index.html.
    const docRef = db.collection('settings').doc(`report_settings_${ROOM_CODE}`);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.log(`⏩ CRON — no existe report_settings_${ROOM_CODE}.`);
      return;
    }

    const cfg = docSnap.data() || {};
    const horaObjetivo = String(cfg.scheduleTime || '').trim().slice(0, 5);
    const phoneK = String(cfg.phoneK || '').replace(/\D/g, '');
    const phoneO = String(cfg.phoneO || '').replace(/\D/g, '');

    console.log(
      `🕒 CRON — ahora=${horaActualLocal} objetivo=${horaObjetivo || '—'} K=${phoneK ? 'configurado' : 'vacío'} O=${phoneO ? 'configurado' : 'vacío'}`
    );

    if (!/^\d{2}:\d{2}$/.test(horaObjetivo)) return;
    if (horaActualLocal !== horaObjetivo) return;

    if (ultimaFechaEjecutada === fechaActualLocal) {
      console.log(`⏩ CRON — ya ejecutado hoy (${fechaActualLocal}).`);
      return;
    }

    const destinatarios = [
      ['K', phoneK],
      ['O', phoneO]
    ].filter(([, phone]) => phone);

    if (!destinatarios.length) {
      console.log('⚠️ CRON — no hay teléfonos K/O en la configuración de index.html.');
      return;
    }

    const snap = await db.collection('tasks')
      .where('room', '==', ROOM_CODE)
      .where('done', '==', false)
      .where('status', '==', 'active')
      .get();

    if (snap.empty) {
      console.log('⏩ CRON — no hay tareas pendientes.');
      // No se marca como ejecutado: al volver a entrar a otra hora configurada
      // no debe enviar un reporte vacío, y no genera historial de WhatsApp.
      return;
    }

    const grupos = {};
    snap.forEach((d) => {
      const t = d.data() || {};
      const person = t.assignee || 'General';
      (grupos[person] ||= []).push(t);
    });

    const sec = p.second === '24' ? '00' : p.second;
    let report =
      `A las ${hour}:${p.minute}:${sec} del ${Number(p.day)}/${Number(p.month)}/${p.year},\n\n` +
      `Los pendientes son:\n\n`;

    for (const [person, items] of Object.entries(grupos)) {
      report += `👤 ${person}\n\n`;
      items.forEach((t, idx) => {
        report += `${idx + 1}. ${t.title}\n\n`;
      });
    }

    let enviados = 0;

    for (const [label, phone] of destinatarios) {
      try {
        await globalSock.sendMessage(`${phone}@s.whatsapp.net`, {
          text: report.trimEnd()
        });
        enviados++;
        console.log(`✅ CRON — reporte enviado a ${label}.`);
      } catch (sendErr) {
        console.error(`❌ CRON — error enviando a ${label}:`, sendErr.message);
      }
    }

    if (enviados > 0) {
      ultimaFechaEjecutada = fechaActualLocal;
      console.log(`✅ CRON — finalizado correctamente: ${enviados}/${destinatarios.length}.`);
    } else {
      console.log('⚠️ CRON — ningún destinatario recibió el reporte; se reintentará.');
    }
  } catch (e) {
    console.error('❌ ERROR CRON:', e.message);
  }
});

startBot();
