const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// =========================================================================
// ⚙️ TUS CONFIGURACIONES PRINCIPALES
// =========================================================================
const ROOM_CODE = process.env.ROOM_CODE || 'FACEX'; // Tu sala de TaskKeep

// Pon aquí los dígitos del número de tu API de WhatsApp (sin signos +, sin espacios)
// Número de prueba/API de WhatsApp. Se puede sobrescribir con NUMERO_API_LIMPIO en Render.
const NUMERO_API_LIMPIO = String(process.env.NUMERO_API_LIMPIO || '15556741749').replace(/\D/g, '');

const CRON_SECRET = process.env.CRON_SECRET || '';

// =========================================================================
// 1. SERVIDOR WEB EXPRESS (OBLIGATORIO PARA RENDER Y UPTIMEROBOT)
// =========================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let lastQrSvg = null;
let isConnected = false;
let globalSock = null;
let botStarting = false;
let cronRuntimeRegistered = false;
let cronInterval = null;
let botStage = 'Iniciando';
let lastBotError = '';

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

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    qrAvailable: Boolean(lastQrSvg),
    room: ROOM_CODE,
    apiNumber: NUMERO_API_LIMPIO ? `configured:${NUMERO_API_LIMPIO.slice(0,4)}***` : 'not configured',
    stage: botStage,
    error: lastBotError || null,
    updatedAt: new Date().toISOString()
  });
});


app.get('/qr', (req, res) => {
  if (isConnected) return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h3>✅ WhatsApp ya está vinculado y funcionando correctamente.</h3><p>Puedes cerrar esta página.</p></body></html>`);
  if (!lastQrSvg) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;margin-top:40px"><h3>⏳ ${botStage}</h3><p>${lastBotError ? '❌ '+lastBotError : 'Esperando un nuevo código QR…'}</p><p style="color:#667;font-size:12px">Esta página se actualiza automáticamente.</p><p><a href="/status">Ver estado técnico</a></p></body></html>`);
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head><body style="text-align:center;padding:30px;font-family:sans-serif">
      <h2>📲 Escanea este QR con WhatsApp</h2>
      <p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
      <p style="color:#666;font-size:12px">QR actual. La página se actualiza cada 5 segundos.</p>
      <img src="${lastQrSvg}" style="border:1px solid #ccc;padding:10px;border-radius:12px;max-width:360px;background:#fff"/>
      <p style="font-size:12px;color:#667">Estado: ${botStage}</p>
    </body></html>`);
});

// Limpieza de sesión dañada si hiciera falta.
// Al resetear, se eliminan las credenciales de Baileys y se reinicia el proceso
// para garantizar que NO queden dos sockets compitiendo por la misma sesión.
app.get('/reset', async (req, res) => {
  try {
    if (db) {
      const snap = await db.collection('bot_auth').get();
      const batch = db.batch();
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`🧹 Sesión bot_auth eliminada: ${snap.size} documento(s).`);
    }

    isConnected = false;
    lastQrSvg = null;
    console.log('♻️ Reinicio limpio solicitado. Render reiniciará el proceso para generar un QR nuevo.');

    res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px">
        <h3>♻️ Sesión limpiada correctamente.</h3>
        <p>El proceso se reiniciará para generar un QR nuevo.</p>
        <p>Cuando Render muestre <b>Live</b>, abre <a href="/qr">/qr</a>.</p>
      </div>
    `);

    setTimeout(() => process.exit(0), 800);
  } catch (err) {
    console.error('❌ Error limpiando sesión:', err);
    res.status(500).send('Error limpiando sesión: ' + err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));
console.log('🧭 Endpoints: /  /ping  /status  /qr  /reset');

// =========================================================================
// 2. INICIALIZAR FIREBASE ADMIN
// =========================================================================
function cleanEnv(v) {
  return String(v ?? '').replace(/^\uFEFF/, '').trim();
}

function normalizePrivateKey(v) {
  let s = cleanEnv(v);
  // Render can preserve escaped line breaks when the value comes from JSON.
  s = s.replace(/\\n/g, '\n');
  // If the whole value was accidentally JSON-stringified, unwrap it once.
  if (s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s); } catch (_) {}
  }
  return String(s ?? '').replace(/\\n/g, '\n').trim();
}

function tryParseServiceAccount(raw) {
  const text = cleanEnv(raw);
  if (!text) return null;

  // 1) Normal JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  // 2) Base64 JSON
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  return null;
}

function buildFirebaseServiceAccount() {
  let rawAccount = tryParseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);

  // Some secret managers wrap the actual service-account JSON under "default".
  if (rawAccount?.default && typeof rawAccount.default === 'object') {
    rawAccount = rawAccount.default;
  }

  const projectId = cleanEnv(
    rawAccount?.project_id ?? rawAccount?.projectId ?? process.env.FIREBASE_PROJECT_ID
  );
  const clientEmail = cleanEnv(
    rawAccount?.client_email ?? rawAccount?.clientEmail ?? process.env.FIREBASE_CLIENT_EMAIL
  );
  const privateKey = normalizePrivateKey(
    rawAccount?.private_key ?? rawAccount?.privateKey ?? process.env.FIREBASE_PRIVATE_KEY
  );

  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey
  };
}

function validateFirebaseServiceAccount(sa) {
  const problems = [];
  if (!sa.project_id) problems.push('project_id vacío');
  if (!sa.client_email) problems.push('client_email vacío');
  if (!sa.private_key) problems.push('private_key vacío');
  if (sa.private_key && !sa.private_key.includes('BEGIN PRIVATE KEY')) problems.push('private_key no parece una clave PEM válida');
  if (sa.private_key && !sa.private_key.includes('END PRIVATE KEY')) problems.push('private_key incompleta: falta END PRIVATE KEY');
  return problems;
}

const serviceAccount = buildFirebaseServiceAccount();
let db = null;
if (validateFirebaseServiceAccount(serviceAccount).length) {
  const problems = validateFirebaseServiceAccount(serviceAccount);
  lastBotError = `Credencial Firebase inválida: ${problems.join('; ')}`;
  botStage = 'Error de credenciales Firebase';
  console.error('❌ Error Firebase:', lastBotError);
  console.error(`🔎 Firebase diagnostic: project_id=${serviceAccount.project_id ? 'OK' : 'MISSING'}, client_email=${serviceAccount.client_email ? 'OK' : 'MISSING'}, private_key=${serviceAccount.private_key ? `OK(${serviceAccount.private_key.length} chars)` : 'MISSING'}`);
} else {
  try {
    const appAlreadyInitialized = getApps().length > 0;
    const firebaseApp = appAlreadyInitialized
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore(firebaseApp);
    botStage = 'Firebase conectado';
    lastBotError = '';
    console.log(`✅ Firebase conectado correctamente (${appAlreadyInitialized ? 'app existente' : 'app nueva'}).`);
  } catch (err) {
    lastBotError = err?.message || String(err);
    botStage = 'Error inicializando Firebase';
    console.error('❌ Error Firebase:', lastBotError);
    console.error(err?.stack || err);
    console.error(`🔎 Firebase diagnostic: project_id=${serviceAccount.project_id ? 'OK' : 'MISSING'}, client_email=${serviceAccount.client_email ? 'OK' : 'MISSING'}, private_key=${serviceAccount.private_key ? `OK(${serviceAccount.private_key.length} chars)` : 'MISSING'}`);
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
    } catch (e) {
      console.error(`❌ Error guardando sesión [${key}]:`, e.message);
      throw e;
    }
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
  if (botStarting) return;
  if (!db) {
    botStage = 'Esperando Firebase';
    console.log('⏳ Esperando credenciales de Firebase...');
    return;
  }
  botStarting = true;
  botStage = 'Cargando sesión de WhatsApp';
  lastBotError = '';

  const authRef = db.collection('bot_auth');
  const { state, saveCreds } = await useFirestoreAuthSafe(authRef);

  // WhatsApp puede rechazar un cliente con una revisión Web obsoleta.
  // Consultamos la revisión actual de web.whatsapp.com con timeout y, si falla,
  // dejamos que Baileys use su valor incorporado.
  let waVersion;
  botStage = 'Comprobando versión de WhatsApp';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://web.whatsapp.com/sw.js', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'sec-fetch-site': 'none'
      }
    });
    clearTimeout(timer);
    if (r.ok) {
      const js = await r.text();
      const m = js.match(/client_revision[^0-9]{0,100}(\d+)/);
      if (m?.[1]) {
        waVersion = [2, 3000, Number(m[1])];
        console.log('🌐 WhatsApp Web revision:', waVersion.join('.'));
      }
    }
  } catch (e) {
    console.log('⚠️ No se pudo consultar la revisión actual de WhatsApp Web:', e.message);
  }

  const socketConfig = {
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    getMessage: async () => undefined
  };
  if (waVersion) socketConfig.version = waVersion;

  botStage = 'Abriendo conexión de WhatsApp';
  console.log('🔌 Abriendo socket de WhatsApp...');
  const sock = makeWASocket(socketConfig);
  globalSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      botStage = 'QR listo para escanear';
      lastBotError = '';
      lastQrSvg = await qrcode.toDataURL(qr);
      console.log('📲 NUEVO QR DISPONIBLE EN /qr — escanea el más reciente.');
    }
    if (connection === 'close') {
      isConnected = false;
      if (globalSock === sock) globalSock = null;
      botStarting = false;
      const err = lastDisconnect?.error;
      const statusCode = err?.output?.statusCode;
      const errMsg = err?.message || String(err || '');
      lastBotError = errMsg;
      botStage = `WhatsApp desconectado (${statusCode || 'sin código'})`;
      console.error(`❌ Conexión WhatsApp cerrada. Código=${statusCode} Mensaje=${errMsg}`);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`¿Reconectar?: ${shouldReconnect}`);
      if (statusCode === 405) {
        console.error('⚠️ WhatsApp rechazó la revisión del cliente (405/client_too_old). El bot intenta resolver la revisión web actual automáticamente.');
      }
      if (statusCode === 401) {
        console.error('⚠️ Sesión no autorizada. Usa /reset para generar una sesión QR limpia.');
      }
      if (shouldReconnect) setTimeout(() => startBot(), 5000);
    } else if (connection === 'open') {
      botStarting = false;
      isConnected = true;
      lastQrSvg = null;
      lastBotError = '';
      botStage = 'WhatsApp conectado y escuchando';
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

      // 2. PRIVACIDAD ESTRICTA
      // Solo se aceptan mensajes del chat contigo misma o del chat con la API.
      // NUNCA usamos fromMe como criterio de autorización: fromMe también se marca
      // cuando tú escribes a terceros.
      const ownPn = sock.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
      const ownLid = sock.user?.lid ? sock.user.lid.split(':')[0].replace(/\D/g, '') : '';
      const remote = String(msg.key.remoteJid || '');
      const remoteAlt = String(msg.key.remoteJidAlt || '');
      const candidates = [remote, remoteAlt].filter(Boolean);
      const jidUser = jid => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
      const ownChat = candidates.some(jid => {
        const u = jidUser(jid);
        return u && ((ownPn && u === ownPn) || (ownLid && u === ownLid));
      });
      const apiChat = Boolean(NUMERO_API_LIMPIO) && candidates.some(jid => jidUser(jid) === NUMERO_API_LIMPIO);
      const privateUserChat = candidates.some(jid => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
      const esConmigoMisma = ownChat && privateUserChat;
      const esConApi = apiChat && privateUserChat;

      if (!esConmigoMisma && !esConApi) {
        console.log(`⏩ IGNORADO por privacidad: ${remote} | fromMe=${Boolean(msg.key.fromMe)}`);
        continue;
      }

      console.log(`📩 Mensaje AUTORIZADO: ${esConApi ? 'API' : 'chat propio'} [${remote}]`);

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
          // Guardar SOLO en el Buzón de Firebase
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
  // 5. CRON DINÁMICO: HORA Y DESTINATARIOS DESDE FIRESTORE
  // =========================================================================
  function localPeruParts(){
    const now=new Date();
    const fmt=new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const p=Object.fromEntries(fmt.formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    return {date:`${p.year}-${p.month}-${p.day}`,hm:`${p.hour}:${p.minute}`,hms:`${p.hour}:${p.minute}:${p.second}`};
  }
  const cleanPhone=value=>String(value||'').replace(/\D/g,'');
  const toJid=value=>{const p=cleanPhone(value);return p?`${p}@s.whatsapp.net`:''};

  function buildScheduledReport(docs){
    const p=localPeruParts(), groups={};
    docs.forEach(d=>{const t=d.data();(groups[t.assignee||'General'] ||= []).push(t);});
    let out=`A las ${p.hms} del ${Number(p.date.slice(8,10))}/${Number(p.date.slice(5,7))}/${p.date.slice(0,4)},\n\nLos pendientes son:\n\n`;
    for(const [person,items] of Object.entries(groups)){
      out+=`👤 ${person}\n\n`;
      items.forEach((t,i)=>out+=`${i+1}. ${t.title}\n\n`);
    }
    return out.trimEnd();
  }

  async function runScheduledReport(source='internal'){
    if(!db || !globalSock || !isConnected) return {sent:false,reason:'WhatsApp no conectado'};
    try{
      const cfgRef=db.collection('settings').doc('report_settings_'+ROOM_CODE);
      const cfgSnap=await cfgRef.get();
      if(!cfgSnap.exists) return {sent:false,reason:'No existe configuración de reporte'};
      const cfg=cfgSnap.data()||{};
      const target=String(cfg.scheduleTime||'').slice(0,5);
      if(!/^\d{2}:\d{2}$/.test(target)) return {sent:false,reason:'No hay una hora válida guardada desde TaskKeep'};
      const {date,hm}=localPeruParts();
      if(hm!==target) return {sent:false,reason:`No es la hora (${hm}; objetivo ${target})`};

      const taskSnap=await db.collection('tasks').where('room','==',ROOM_CODE).where('done','==',false).where('status','==','active').get();
      if(taskSnap.empty) return {sent:false,reason:'No hay pendientes'};

      const targets=[
        ['K',cleanPhone(cfg.phoneK)],
        ['O',cleanPhone(cfg.phoneO)]
      ].filter(([,p])=>p);
      if(!targets.length) return {sent:false,reason:'No hay teléfonos K/O guardados desde TaskKeep'};

      const lockRef=db.collection('settings').doc('cron_lock_'+ROOM_CODE);
      const lock=await lockRef.get();
      if(lock.exists && String(lock.data()?.date||'')===date) return {sent:false,reason:'Ya enviado hoy'};

      const report=buildScheduledReport(taskSnap.docs), sent=[];
      for(const [label,phone] of targets){
        try{await globalSock.sendMessage(toJid(phone),{text:report}); sent.push(label); console.log(`✅ Reporte automático enviado a ${label}`);}
        catch(err){console.error(`❌ Error enviando a ${label}:`,err.message);}
      }
      if(sent.length) await lockRef.set({room:ROOM_CODE,date,sentAt:Date.now(),sentTo:sent,source},{merge:true});
      return {sent:sent.length>0,targets:sent,reason:sent.length?'Enviado':'Fallaron todos los destinatarios'};
    }catch(e){console.error('❌ Error en reporte programado:',e);return {sent:false,reason:e.message||String(e)};}
  }

  // Endpoint para cron-job.org. Se registra una sola vez aunque WhatsApp se reconecte.
  if (!cronRuntimeRegistered) {
    cronRuntimeRegistered = true;
    app.get('/cron-tick',async(req,res)=>{
      if(CRON_SECRET && req.query.key!==CRON_SECRET) return res.status(401).json({ok:false,error:'Unauthorized'});
      const result=await runScheduledReport('cron-job.org');
      res.json({ok:true,...result});
    });

    // Comprobación frecuente mientras Render está despierto. La hora real siempre
    // se lee de settings/report_settings_<ROOM_CODE>, guardada por TaskKeep.
    cronInterval = setInterval(async()=>{
      try { await runScheduledReport('internal'); } catch (e) {}
    },5000);
  }

  botStarting = false;
}

startBot().catch(err=>{lastBotError=err?.message||String(err);botStage='Error al iniciar';botStarting=false;console.error('❌ ERROR FATAL AL INICIAR TASKKEEP BOT:',err);process.exitCode=1;});
