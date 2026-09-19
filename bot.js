const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');

// 1. Inicializar Firebase Admin
const serviceAccount = require('./firebase-key.json'); // Descargada desde consola de Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const ROOM_CODE = "EQUIPO1"; // Tu sala configurada

// 2. Inicializar Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);

  console.log("🟢 Bot de WhatsApp listo. Esperando mensajes...");

  // ESCUCHAR MENSAJES Y AUDIOS ENTRANTES
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.pushName || "WhatsApp";
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    // SI ES UN AUDIO DE WHATSAPP (.OGG)
    const isAudio = msg.message.audioMessage;
    if (isAudio) {
      console.log(`🎙️ Audio recibido de ${sender}. Descargando y procesando con Gemini...`);
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      
      // Enviar audio a Gemini
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [
          { text: "Extrae las tareas pendientes mencionadas en este audio en formato lista:" },
          { inlineData: { mimeType: 'audio/ogg', data: buffer.toString('base64') } }
        ]
      });

      text = `[Transcripción de Nota de Voz]: ${response.text}`;
    }

    if (text) {
      // Guardar directamente en el Buzón de la Sala en Firestore
      await db.collection('inbox').add({
        room: ROOM_CODE,
        sender: sender,
        text: text,
        timestamp: Date.now()
      });
      console.log(`✅ Mensaje de ${sender} guardado en el buzón de la sala.`);
    }
  });

  // CRON DIARIO AUTOMÁTICO (Todos los días a las 09:00 AM)
  // No necesitas laptop encendida, corre en el servidor
  cron.schedule('0 9 * * *', async () => {
    console.log("⏰ Ejecutando cron diario de pendientes...");
    const snap = await db.collection('tasks').where('room', '==', ROOM_CODE).where('done', '==', false).get();
    
    let report = "*Buen día, tus tareas pendientes para hoy son:*\n\n";
    snap.forEach(doc => {
      const t = doc.data();
      report += `• [${t.assignee || 'General'}] ${t.title}\n`;
    });
    report += "\nQuedamos al pendiente.";

    // Números de destino (ejemplo K y O)
    const destinatarios = ["51987654321@s.whatsapp.net", "51912345678@s.whatsapp.net"];
    for (const jid of destinatarios) {
      await sock.sendMessage(jid, { text: report });
    }
    console.log("✅ Reporte cron enviado automáticamente a WhatsApp.");
  });
}

startBot();
