const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
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

// Teléfonos de RESPALDO para el reporte diario, usados SOLO si en TaskKeep (Reloj/Cron) no hay
// ningún teléfono K u O configurado todavía. Si ya configuras los teléfonos en la web, el bot
// usa esos automáticamente y esta lista deja de usarse.
// ⚠️ Ojo: estas dos líneas tienen el MISMO número repetido; si de verdad quieres 2 destinatarios
// fijos de respaldo, cambia uno de los dos números.
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
      <div style="margin-top:20px">
        <a href="/qr" style="background:#0f9d73;color:white;padding:10px 16px;border-radius:8px;text-decoration:none;margin-right:10px">Ver Código QR</a>
        <a href="/reset" onclick="return confirm('¿Reiniciar sesión dañada?')" style="background:#e85b72;color:white;padding:10px 16px;border-radius:8px;text-decoration:none">Reiniciar Sesión Dañada</a>
      </div>
    </div>
  `);
});

// Render (plan gratuito) apaga el servicio tras ~15 min sin tráfico HTTP. Si eso pasa, TODO el
// proceso se detiene (incluida la sesión de WhatsApp y el cron), así que el reporte programado
// NO se envía hasta que algo "despierte" al servicio. Para que el bot quede realmente activo
// 24/7 (aunque tu laptop/app estén apagados), hay que pedirle a un servicio externo tipo
// UptimeRobot que visite esta URL cada 5-10 minutos: https://TU-APP.onrender.com/ping
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

// Normaliza un JID (quita sufijo de dispositivo, minúsculas) usando el helper OFICIAL de Baileys
// en vez de una expresión regular propia, para no romper con formatos que no habíamos previsto.
const normalizeJid = (jid) => (jid ? jidNormalizedUser(jid) : '');

// WhatsApp identifica a cada cuenta de DOS formas distintas (esto viene de la documentación
// oficial de Baileys 7.x): PNJID (número de teléfono, ...@s.whatsapp.net) y LIDJID (identidad
// "escondida", ...@lid). Un mismo chat puede aparecer con cualquiera de las dos formas según el
// momento, así que para reconocer "soy yo" o "es mi API" hay que conocer AMBAS formas de cada
// uno, no solo una. apiJidPN / apiJidLID guardan esas dos formas para el número de la API.
let apiJidPN = null;
let apiJidLID = null;

async function resolveApiJid(sock) {
  try {
    const resultados = await sock.onWhatsApp(NUMERO_API_LIMPIO);
    const encontrado = resultados && resultados[0];
    if (!encontrado?.exists || !encontrado?.jid) {
      console.log('⚠️ No se pudo confirmar el número de la API en WhatsApp (¿está bien escrito NUMERO_API_LIMPIO?).');
      return;
    }
    const nuevoPN = normalizeJid(encontrado.jid);
    if (nuevoPN !== apiJidPN) {
      console.log(`🔗 JID (PN) real de la API resuelto: ${nuevoPN}`);
    }
    apiJidPN = nuevoPN;

    // También intentamos obtener la forma @lid de ese mismo número, por si WhatsApp te muestra
    // ese chat en formato @lid en vez de con el número (esto es justo lo que le pasaba a tu
    // propio chat "Tú", según confirmaron tus logs).
    try {
      const lid = await sock.signalRepository?.lidMapping?.getLIDForPN(apiJidPN);
      if (lid) {
        const nuevoLid = normalizeJid(lid);
        if (nuevoLid !== apiJidLID) console.log(`🔗 JID (LID) real de la API resuelto: ${nuevoLid}`);
        apiJidLID = nuevoLid;
      }
    } catch (e) { /* no siempre hay mapeo LID todavía; no es un error grave */ }
  } catch (e) {
    console.error('⚠️ Error resolviendo el JID de la API:', e.message);
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

  console.log(`⚙️ NUMERO_API_LIMPIO configurado: ${NUMERO_API_LIMPIO}`);
  if (NUMERO_API_LIMPIO === '15556741749') {
    console.log('⚠️ NUMERO_API_LIMPIO todavía tiene el valor de ejemplo original. Si ese no es realmente el número de tu API, cámbialo al inicio del archivo.');
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
      resolveMiPropioJid(sock);
      resolveApiJid(sock);
      listarGruposDisponibles(sock);
    }
  });

  // Igual que con la API: obtiene la forma @lid de tu PROPIA cuenta. sock.user solo trae la forma
  // por número (PN); la forma @lid ("Linked Identity") se consigue aparte, vía el mapeo oficial
  // de Baileys. Esto es justo lo que faltaba: por eso salía "miJidLid" vacío en tus logs.
  let miJidPN = null;
  let miJidLID = null;
  async function resolveMiPropioJid(sock) {
    try {
      miJidPN = normalizeJid(sock.user?.id);
      const lid = await sock.signalRepository?.lidMapping?.getLIDForPN(miJidPN);
      if (lid) {
        const nuevo = normalizeJid(lid);
        if (nuevo !== miJidLID) console.log(`🔗 Tu propio JID (LID) resuelto: ${nuevo}`);
        miJidLID = nuevo;
      } else {
        console.log('⚠️ Todavía no se pudo resolver tu propio JID @lid; se reintentará con cada mensaje que no coincida.');
      }
    } catch (e) {
      console.error('⚠️ Error resolviendo tu propio JID @lid:', e.message);
    }
  }

  // Lista los grupos donde está tu cuenta, para que puedas copiar el JID (termina en @g.us) del
  // grupo "yo sola/o" y pegarlo en TaskKeep > Reporte programado > "Grupo para el reporte del cron".
  async function listarGruposDisponibles(sock) {
    try {
      const grupos = await sock.groupFetchAllParticipating();
      const lista = Object.values(grupos);
      if (!lista.length) {
        console.log('ℹ️ Esta cuenta de WhatsApp no está en ningún grupo todavía.');
        return;
      }
      console.log('📋 Grupos disponibles (copia el JID del que quieras usar para el reporte del cron):');
      lista.forEach(g => console.log(`   • "${g.subject}" → ${g.id}`));
    } catch (e) {
      console.error('⚠️ No se pudo listar los grupos:', e.message);
    }
  }

  // Protección contra "eco": guarda el id de cada mensaje que EL PROPIO BOT envía (por ejemplo,
  // el reporte del cron), para no volver a procesarlo como si fuera un mensaje nuevo que llegó.
  // Sin esto, si el reporte se manda a tu propio chat "Tú", el bot se lo vuelve a leer a sí mismo
  // y lo mete otra vez al Buzón, generando un círculo vicioso.
  const idsEnviadosPorElBot = new Set();
  async function enviarYRegistrar(sock, jid, contenido) {
    const res = await sock.sendMessage(jid, contenido);
    if (res?.key?.id) {
      idsEnviadosPorElBot.add(res.key.id);
      // Evita que el Set crezca indefinidamente
      if (idsEnviadosPorElBot.size > 200) {
        const primero = idsEnviadosPorElBot.values().next().value;
        idsEnviadosPorElBot.delete(primero);
      }
    }
    return res;
  }

  // Refresca los JIDs resueltos (el tuyo y el de la API) cada 30 min, por si WhatsApp cambia su
  // direccionamiento.
  if (globalThis.__jidRefreshInterval) clearInterval(globalThis.__jidRefreshInterval);
  globalThis.__jidRefreshInterval = setInterval(() => {
    if (isConnected) {
      resolveMiPropioJid(sock);
      resolveApiJid(sock);
    }
  }, 30 * 60 * 1000);

  // ESCUCHAR MENSAJES Y FILTRAR PRIVACIDAD
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg) continue;

      // 0. Si este mensaje lo mandó el propio bot (por ejemplo, el reporte del cron), se ignora
      //    para no reprocesarlo como si fuera un mensaje nuevo (rompe el círculo vicioso).
      if (msg.key.id && idsEnviadosPorElBot.has(msg.key.id)) {
        idsEnviadosPorElBot.delete(msg.key.id);
        continue;
      }

      // 1. Desenvolver mensaje si viene como temporal o vista única
      let m = msg.message;
      if (m?.ephemeralMessage) m = m.ephemeralMessage.message;
      if (m?.viewOnceMessage) m = m.viewOnceMessage.message;
      if (m?.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
      if (m?.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

      if (!m) continue;

      const chatOrigen = msg.key.remoteJid || '';
      // remoteJidAlt: Baileys ya trae, EN EL MISMO MENSAJE, la identidad "alterna" (si remoteJid
      // vino en @lid, acá suele venir la forma con número, y viceversa). Usar esto es más directo
      // y confiable que intentar resolverlo nosotros por separado.
      const chatAlt = msg.key.remoteJidAlt || '';

      const chatNorm = normalizeJid(chatOrigen);
      const chatAltNorm = normalizeJid(chatAlt);

      // 🔎 LOG DE DIAGNÓSTICO: se imprime SIEMPRE que llega un mensaje.
      console.log(`🔎 Mensaje recibido | remoteJid="${chatOrigen}" (alt="${chatAlt}") | fromMe=${msg.key.fromMe} | miJidPN="${miJidPN}" | miJidLID="${miJidLID}" | apiJidPN="${apiJidPN}" | apiJidLID="${apiJidLID}"`);

      // 🛡️ REGLA DE PRIVACIDAD ESTRICTA:
      // A) ¿Es tu chat "Tú" (contigo misma)? Se compara el JID del chat (y su forma alterna)
      //    contra TU propio JID en sus dos formas posibles (número y @lid). Ya NO se usa
      //    "fromMe && endsWith('@lid')", porque esa condición también es verdadera cuando le
      //    escribes a CUALQUIER contacto que WhatsApp te muestre en formato @lid, y por eso se
      //    estaban copiando mensajes que le mandabas a otras personas.
      const coincideConmigo = (jid) => Boolean(jid && ((miJidPN && jid === miJidPN) || (miJidLID && jid === miJidLID)));
      let esConmigoMisma = coincideConmigo(chatNorm) || coincideConmigo(chatAltNorm);

      // B) ¿Es el chat con el número de tu API? Misma idea: comparar contra ambas formas del
      //    JID de la API, resueltas en vivo contra WhatsApp (no contra dígitos sueltos, porque
      //    en formato @lid los dígitos del chat no tienen relación con el número real).
      const coincideConApi = (jid) => Boolean(jid && ((apiJidPN && jid === apiJidPN) || (apiJidLID && jid === apiJidLID)));
      let esConApi = coincideConApi(chatNorm) || coincideConApi(chatAltNorm);

      // Si ninguno coincidió y todavía nos faltaba resolver algo (por ejemplo, justo después de
      // reiniciar el bot), lo intentamos una vez más aquí mismo antes de descartar el mensaje.
      if (!esConmigoMisma && !esConApi) {
        if (!miJidLID) await resolveMiPropioJid(sock);
        if (!apiJidPN) await resolveApiJid(sock);
        esConmigoMisma = coincideConmigo(chatNorm) || coincideConmigo(chatAltNorm);
        esConApi = coincideConApi(chatNorm) || coincideConApi(chatAltNorm);
      }

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
  let ultimaHoraObjetivoLogueada = '';
  console.log(`🕐 Cron activo. Revisará cada minuto la hora guardada en settings/report_settings_${ROOM_CODE}.`);

  // Revisa cada minuto si ya llegó la hora que pusiste en la web
  cron.schedule('* * * * *', async () => {
    try {
      // 1. Obtener la hora actual en tu zona horaria local (Perú/Colombia/Ecuador)
      const ahora = new Date();
      const opcionesHora = { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false };
      const horaActualLocal = new Intl.DateTimeFormat('es-PE', opcionesHora).format(ahora);
      const fechaActualLocal = ahora.toISOString().slice(0, 10);

      // 2. Leer la configuración que pusiste en TaskKeep desde Firebase.
      //    OJO: esto se ejecuta cada minuto y SIEMPRE vuelve a leer el documento de Firestore,
      //    así que si cambias la hora (o los teléfonos) en TaskKeep, el bot lo detecta solo,
      //    en el siguiente minuto, sin que reinicies nada.
      let horaObjetivo = '09:00'; // Por defecto 9:00 AM si aún no configuraste nada en TaskKeep
      const docConfig = await db.collection('settings').doc('report_settings_' + ROOM_CODE).get();
      const configData = docConfig.exists ? docConfig.data() : {};

      if (configData.scheduleTime) {
        horaObjetivo = String(configData.scheduleTime).trim();
        // Normaliza por si TaskKeep llegara a guardar "9:00" en vez de "09:00"
        const [h, mnt] = horaObjetivo.split(':');
        if (h && mnt) horaObjetivo = `${h.padStart(2, '0')}:${mnt.padStart(2, '0')}`;
      }

      // Avisa en el log cada vez que detecta un cambio de hora objetivo, para poder confirmar
      // desde los logs de Render que sí está leyendo lo que guardas en TaskKeep.
      if (horaObjetivo !== ultimaHoraObjetivoLogueada) {
        console.log(`🔁 Hora objetivo leída de TaskKeep: ${horaObjetivo} (hora local ahora: ${horaActualLocal})`);
        ultimaHoraObjetivoLogueada = horaObjetivo;
      }
      // Latido cada 15 min para confirmar que el cron sigue vivo aunque no sea la hora todavía.
      if (ahora.getMinutes() % 15 === 0) {
        console.log(`💓 Cron vivo. Hora local: ${horaActualLocal} · Hora objetivo: ${horaObjetivo} · Ya enviado hoy: ${ultimaFechaEjecutada === fechaActualLocal ? 'sí' : 'no'}`);
      }

      // 3. Destinatarios, en este orden de prioridad:
      //    a) El grupo configurado en TaskKeep (settings.groupJid) — el más recomendable, porque
      //       evita el círculo vicioso de mandarte el reporte a tu propio chat "Tú".
      //    b) Los teléfonos K y O guardados en TaskKeep (settings.phoneK / settings.phoneO).
      //    c) La lista fija DESTINATARIOS_CRON, solo si no hay nada configurado en la web.
      let destinatariosFinales = [];
      if (configData.groupJid && String(configData.groupJid).trim()) {
        destinatariosFinales = [String(configData.groupJid).trim()];
      } else {
        const destinatarios = [];
        if (configData.phoneK) destinatarios.push(String(configData.phoneK).replace(/\D/g, '') + '@s.whatsapp.net');
        if (configData.phoneO) destinatarios.push(String(configData.phoneO).replace(/\D/g, '') + '@s.whatsapp.net');
        destinatariosFinales = [...new Set(destinatarios.length ? destinatarios : DESTINATARIOS_CRON)];
      }

      // 4. Si la hora actual coincide con la hora configurada en TaskKeep y no se ha enviado hoy:
      if (horaActualLocal === horaObjetivo && ultimaFechaEjecutada !== fechaActualLocal) {
        console.log(`⏰ ¡Son las ${horaActualLocal}! Disparando reporte automático sincronizado...`);
        ultimaFechaEjecutada = fechaActualLocal;

        if (!destinatariosFinales.length) {
          console.log('⚠️ No hay destinatarios configurados (ni en TaskKeep ni en DESTINATARIOS_CRON). No se envía nada.');
          return;
        }

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

        for (const jid of destinatariosFinales) {
          await enviarYRegistrar(sock, jid, { text: report });
          console.log(`📤 Reporte cron enviado a ${jid}`);
        }
        console.log('✅ Reporte cron enviado con éxito a la hora programada.');
      }
    } catch (e) {
      console.error('❌ Error en cron dinámico:', e.message);
    }
  });
}

startBot();
