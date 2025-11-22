import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import qrcode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { supabase } from './supabaseClient.js';
import { useSupabaseAuthState } from './supabase-auth.js';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

const sessions = new Map();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ============================================================
   MEMORY USAGE LOGGER
============================================================ */
function logMemoryUsage(context = 'General') {
  const mem = process.memoryUsage();
  const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  const cpu = process.cpuUsage();
  console.log(`\n💾 [${context}] Memory Usage`);
  console.log(`   Heap Used: ${toMB(mem.heapUsed)} MB`);
  console.log(`   CPU User: ${(cpu.user / 1000).toFixed(2)} ms`);
}

/* ============================================================
   START SESSION
============================================================ */
async function startWhatsAppSession(sessionId) {
  if (sessions.has(sessionId)) {
    console.log(`[${sessionId}] Already active`);
    return { success: true, status: sessions.get(sessionId).status };
  }

  const sessionInfo = {
    socket: null,
    qr: null,
    status: 'initializing',
    phone: null,
    retries: 0
  };

  sessions.set(sessionId, sessionInfo);

  await connectToWhatsApp(sessionId, sessionInfo);

  return { success: true, status: 'initializing' };
}

/* ============================================================
   CONNECT TO WHATSAPP
============================================================ */
async function connectToWhatsApp(sessionId, sessionInfo) {
  console.log(`🔄 [${sessionId}] Initializing WhatsApp connection...`);

  const { state, saveCreds } = await useSupabaseAuthState(sessionId, logger);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['Chrome', 'Linux', '110.0.0.0'],
    markOnlineOnConnect: false,
  });

  sessionInfo.socket = sock;

  const MAX_RETRIES = 1;
  const QR_VALIDITY_MS = 60000;

  /* CONNECTION EVENTS */
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sessionInfo.qr) {
      const qrImage = await qrcode.toDataURL(qr);
      sessionInfo.qr = qrImage;
      sessionInfo.status = 'qr_ready';
      sessionInfo.qr_expiry = Date.now() + QR_VALIDITY_MS;

      console.log(`[${sessionId}] ✅ QR ready`);

      await notifyBackend(sessionId, 'qr_ready', {
        qr: qrImage,
        expires_in: QR_VALIDITY_MS / 1000
      });

      setTimeout(() => {
        if (Date.now() > sessionInfo.qr_expiry && sessionInfo.status !== 'connected') {
          console.log(`[${sessionId}] ⏱️ QR expired`);
          sessionInfo.qr = null;
          sessionInfo.status = 'expired';
          notifyBackend(sessionId, 'disconnected', { reason: 'qr_expired' });
        }
      }, QR_VALIDITY_MS);
    }

    if (connection === 'open') {
      sessionInfo.status = 'connected';
      const phoneNumber = sock.user?.id?.split(':')[0] || 'unknown';
      const userName = sock.user?.name || sock.user?.verifiedName || 'User';
      sessionInfo.phone = phoneNumber;

      console.log(`[${sessionId}] ✅ Connected as ${phoneNumber}`);

      await notifyBackend(sessionId, 'connected', {
        phone: phoneNumber,
        name: userName
      });
    }
    
    /* CONNECTION CLOSED */
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error || 'unknown';

      console.log(`[${sessionId}] ⚠️ Connection closed: ${reason} (Code: ${code})`);

      /* ⭐ AUTO-LOGOUT WHEN USER UNLINKS DEVICE FROM WHATSAPP ⭐ */
      if (code === 401) {
        console.log(`[${sessionId}] 🔥 User logged out directly from WhatsApp`);
        
        // Clean up local session
        sessions.delete(sessionId);
        
        // Notify backend about the logout
        await notifyBackend(sessionId, 'user_logout', {
          reason: 'logged_out_from_whatsapp',
          message: 'User removed device from WhatsApp',
          timestamp: new Date().toISOString()
        });
        
        // Clean up auth files
        const authPath = `./auth_info_baileys/${sessionId}`;
        try {
          await fs.promises.rm(authPath, { recursive: true, force: true });
          console.log(`[${sessionId}] 🗑️ Auth files deleted`);
        } catch (err) {
          console.log(`[${sessionId}] ⚠️ Could not delete auth files: ${err.message}`);
        }
        
        return; // Stop reconnection attempts
      }

      /* NORMAL RECONNECT BEHAVIOR FOR OTHER ERRORS */
      if (sessionInfo.retries >= MAX_RETRIES) {
        console.log(`[${sessionId}] ❌ Max retries reached`);
        sessions.delete(sessionId);
        await notifyBackend(sessionId, 'disconnected', { reason: 'max_retries' });
      } else {
        sessionInfo.retries++;
        console.log(`[${sessionId}] 🔄 Reconnecting (attempt ${sessionInfo.retries}/${MAX_RETRIES})...`);
        setTimeout(() => connectToWhatsApp(sessionId, sessionInfo), 3000);
      }
    }
  });

   
  /* MESSAGE RECEIVED */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    // If we are receiving messages, we are definitely connected.
    if (sessionInfo.status !== 'connected') {
      console.log(`[${sessionId}] ⚠️ Status auto-corrected to 'connected' based on activity.`);
      sessionInfo.status = 'connected';
  }
  // 👆 END OF ADDITION 👆
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const messageData = {
        id: msg.key.id,
        from: msg.key.remoteJid,
        fromMe: msg.key.fromMe,
        timestamp: msg.messageTimestamp,
        message: extractMessageContent(msg)
      };

      console.log(`[${sessionId}] 📨 New message from ${messageData.from}`);

      await notifyBackend(sessionId, 'message_received', messageData);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

/* ============================================================
   EXTRACT MESSAGE CONTENT
============================================================ */
function extractMessageContent(msg) {
  const m = msg.message;

  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text };
  if (m.imageMessage) return { type: 'image', caption: m.imageMessage.caption || '' };
  if (m.videoMessage) return { type: 'video', caption: m.videoMessage.caption || '' };

  return { type: 'unknown' };
}

/* ============================================================
   NOTIFY BACKEND (MULTI-WEBHOOK)
============================================================ */
async function notifyBackend(sessionId, event, data) {
  try {
    let endpoint = '/whatsapp/webhook';

    if (event === 'qr_ready') endpoint = '/whatsapp/webhook/qr';
    else if (event === 'connected') endpoint = '/whatsapp/webhook/connected';
    else if (event === 'message_received') endpoint = '/whatsapp/webhook/message';
    else if (event === 'disconnected') endpoint = '/whatsapp/webhook/disconnect';
    else if (event === 'user_logout') endpoint = '/whatsapp/webhook/user-logout';
    await axios.post(`${BACKEND_URL}${endpoint}`, {
      session_id: sessionId,
      event,
      data
    });

    console.log(`[${sessionId}] 📡 Sent ${event} → ${endpoint}`);
  } catch (err) {
    console.error(`[${sessionId}] ⚠️ Failed to notify backend: ${err.message}`);
  }
}

/* ============================================================
   AUTO RESTORE SESSIONS ON NODE STARTUP
============================================================ */
async function autoRestoreSessions() {
  console.log("🔄 Restoring WhatsApp sessions from Supabase...");

  const { data, error } = await supabase
    .from("whatsapp_sessions")
    .select("id, auth_data");

  if (error) {
    console.error("❌ Failed loading sessions:", error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log("ℹ️ No sessions found in Supabase");
    return;
  }

  console.log(`📦 Found ${data.length} session(s) to restore`);

  for (const row of data) {
    if (!row.auth_data) {
      console.log(`⚠️ Skipping session ${row.id} (no auth_data)`);
      continue;
    }

    console.log(`♻️ Restoring session: ${row.id}`);

    const sessionInfo = {
      socket: null,
      qr: null,
      status: "restoring",
      phone: null,
      retries: 0
    };

    sessions.set(row.id, sessionInfo);

    setTimeout(() => {
      console.log(`🔌 Reconnecting restored session ${row.id}...`);
      connectToWhatsApp(row.id, sessionInfo);
    }, 800);
  }
}

/* ============================================================
   EXPRESS ROUTES
============================================================ */

// Start a new session
app.post('/session/start', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }

  console.log(`\n🚀 Starting session: ${session_id}`);

  const result = await startWhatsAppSession(session_id);

  res.json(result);
});

// Send a message
app.post('/session/:sessionId/send', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;

  const session = sessions.get(sessionId);

  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }

  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

  try {
    const sent = await session.socket.sendMessage(jid, { text });
    console.log(`[${sessionId}] ✅ Message sent to ${to}`);
    res.json({ success: true, id: sent.key.id });
  } catch (err) {
    console.error(`[${sessionId}] ❌ Send failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect and remove session from memory
app.post('/session/:sessionId/disconnect', async (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);

  if (!session) {
    console.log(`[${sessionId}] ⚠️ No active session found (already cleared)`);
    return res.json({
      success: true,
      message: "Session already cleared from memory"
    });
  }

  try {
    // Logout WhatsApp socket if exists
    if (session.socket) {
      try {
        await session.socket.logout();
        console.log(`[${sessionId}] 🔌 WhatsApp logged out`);
      } catch (err) {
        console.log(`[${sessionId}] ⚠️ Logout error (ignored):`, err.message);
      }
    }

    // Remove from memory Map
    sessions.delete(sessionId);
    console.log(`[${sessionId}] 🧹 Session removed from memory`);

    return res.json({
      success: true,
      message: "WhatsApp session disconnected and removed from memory"
    });

  } catch (err) {
    console.error(`[${sessionId}] ❌ Disconnect failed:`, err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Get session status
app.get('/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    session_id: sessionId,
    status: session.status,
    phone: session.phone,
    qr: session.qr
  });
});

// Health check
app.get('/health', (req, res) => {
  const activeSessions = Array.from(sessions.keys());
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sessions: activeSessions.length,
    active_sessions: activeSessions
  });
});

/* ============================================================
   START SERVER
============================================================ */
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n✅ WhatsApp Service running on 0.0.0.0:${PORT}`);
  console.log(`📡 Backend webhook base: ${BACKEND_URL}/whatsapp/webhook/*`);
  console.log(`💻 Platform: ${os.platform()} ${os.arch()}`);
  console.log(`📊 Node version: ${process.version}\n`);

  // Restore sessions from Supabase
  await autoRestoreSessions();

  // Periodic memory monitoring
  setInterval(() => logMemoryUsage('Periodic Monitor'), 30000);
});