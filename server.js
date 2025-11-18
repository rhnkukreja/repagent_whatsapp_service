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
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

const sessions = new Map();
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' }); // Reduce log noise

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
   GLOBAL ERROR HANDLERS (PREVENT CRASHES)
============================================================ */
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
  console.error(err.stack);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - keep server running
});

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
   CONNECT TO WHATSAPP (WITH IMPROVED ERROR HANDLING)
============================================================ */
async function connectToWhatsApp(sessionId, sessionInfo) {
  console.log(`🔄 [${sessionId}] Initializing WhatsApp connection...`);

  try {
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
      connectTimeoutMs: 60000, // Increase timeout to 60s
      defaultQueryTimeoutMs: 60000, // Increase query timeout
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      // Additional stability options
      getMessage: async (key) => {
        return { conversation: '' };
      }
    });

    sessionInfo.socket = sock;

    const MAX_RETRIES = 3; // Increase max retries
    const QR_VALIDITY_MS = 60000;

    /* CONNECTION EVENTS */
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !sessionInfo.qr) {
        try {
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
        } catch (qrErr) {
          console.error(`[${sessionId}] ❌ QR generation error:`, qrErr.message);
        }
      }

      if (connection === 'open') {
        sessionInfo.status = 'connected';
        sessionInfo.retries = 0; // Reset retry counter
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const error = lastDisconnect?.error;
        
        console.log(`[${sessionId}] ⚠️ Connection closed`);
        console.log(`   Status Code: ${statusCode}`);
        console.log(`   Error: ${error?.message || 'unknown'}`);

        /* USER LOGGED OUT FROM WHATSAPP */
        if (statusCode === 401) {
          console.log(`[${sessionId}] 🔥 User logged out from WhatsApp`);
          
          sessions.delete(sessionId);
          
          await notifyBackend(sessionId, 'user_logout', {
            reason: 'logged_out_from_whatsapp',
            message: 'User removed device from WhatsApp',
            timestamp: new Date().toISOString()
          });
          
          return; // Stop reconnection
        }

        /* TIMEOUT ERRORS - RETRY WITH BACKOFF */
        if (statusCode === 408 || error?.message?.includes('Timed Out')) {
          console.log(`[${sessionId}] ⏱️ Timeout detected - implementing retry with backoff`);
          
          if (sessionInfo.retries >= MAX_RETRIES) {
            console.log(`[${sessionId}] ❌ Max retries reached after timeouts`);
            sessions.delete(sessionId);
            await notifyBackend(sessionId, 'disconnected', { 
              reason: 'timeout_max_retries',
              message: 'Connection timed out multiple times'
            });
            return;
          }
          
          sessionInfo.retries++;
          const backoffDelay = Math.min(3000 * Math.pow(2, sessionInfo.retries - 1), 30000);
          console.log(`[${sessionId}] 🔄 Reconnecting after ${backoffDelay}ms (attempt ${sessionInfo.retries}/${MAX_RETRIES})...`);
          
          setTimeout(() => connectToWhatsApp(sessionId, sessionInfo), backoffDelay);
          return;
        }

        /* NORMAL RECONNECT FOR OTHER ERRORS */
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

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        try {
          const messageData = {
            id: msg.key.id,
            from: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
            timestamp: msg.messageTimestamp,
            message: extractMessageContent(msg)
          };

          console.log(`[${sessionId}] 📨 New message from ${messageData.from}`);

          await notifyBackend(sessionId, 'message_received', messageData);
        } catch (msgErr) {
          console.error(`[${sessionId}] ❌ Message processing error:`, msgErr.message);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error(`[${sessionId}] ❌ Fatal connection error:`, err.message);
    console.error(err.stack);
    
    // Clean up and notify
    sessions.delete(sessionId);
    await notifyBackend(sessionId, 'disconnected', { 
      reason: 'fatal_error',
      error: err.message 
    });
  }
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
    }, {
      timeout: 10000 // 10 second timeout for backend calls
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

  try {
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

      // Stagger reconnections to avoid overwhelming the system
      const delay = 1000 + (Math.random() * 2000);
      setTimeout(() => {
        console.log(`🔌 Reconnecting restored session ${row.id}...`);
        connectToWhatsApp(row.id, sessionInfo);
      }, delay);
    }
  } catch (err) {
    console.error("❌ Auto-restore error:", err.message);
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

  try {
    const result = await startWhatsAppSession(session_id);
    res.json(result);
  } catch (err) {
    console.error(`❌ Session start error:`, err.message);
    res.status(500).json({ error: err.message });
  }
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
  setInterval(() => logMemoryUsage('Periodic Monitor'), 60000); // Reduced frequency
});