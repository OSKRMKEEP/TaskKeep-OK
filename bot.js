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
const NUMERO_API_LIMPIO = String(process.env.NUMERO_API_LIMPIO || '').replace(/\D/g, '');
const CRON_SECRET = process.env.CRON_SECRET || '';

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
      const target=String(cfg.scheduleTime||'09:00').slice(0,5);
      const {date,hm}=localPeruParts();
      if(hm!==target) return {sent:false,reason:`No es la hora (${hm}; objetivo ${target})`};

      const taskSnap=await db.collection('tasks').where('room','==',ROOM_CODE).where('done','==',false).where('status','==','active').get();
      if(taskSnap.empty) return {sent:false,reason:'No hay pendientes'};

      const targets=[['K',cleanPhone(cfg.phoneK)],['O',cleanPhone(cfg.phoneO)]].filter(([,p])=>p);
      if(!targets.length) return {sent:false,reason:'No hay teléfonos K/O configurados en esta sala'};

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

  // Endpoint para cron-job.org. Permite mantener el servicio activo y disparar el
  // reporte leyendo la hora actual configurada en la aplicación.
  app.get('/cron-tick',async(req,res)=>{
    if(CRON_SECRET && req.query.key!==CRON_SECRET) return res.status(401).json({ok:false,error:'Unauthorized'});
    const result=await runScheduledReport('cron-job.org');
    res.json({ok:true,...result});
  });

  // Comprobación frecuente mientras el proceso de Render está despierto.
  setInterval(()=>runScheduledReport('internal').catch(()=>{}),5000);
}

startBot().catch(err=>{console.error('❌ ERROR FATAL AL INICIAR TASKKEEP BOT:',err);process.exitCode=1;});
