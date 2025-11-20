import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import qrcode from 'qrcode';
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { supabase } from './supabaseClient.js';
import { useSupabaseAuthState } from './supabase-auth.js';
import pino from 'pino';
import cluster from 'cluster';
import crypto from 'crypto';

// CONFIGURATION
// Use 4 workers for 100 users (25 users per worker is very safe)
const TOTAL_WORKERS = process.env.WORKERS || 4; 
const PORT = 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

// -----------------------------------------------------------------------------
// HELPER: Determine which worker owns a session
// -----------------------------------------------------------------------------
function getWorkerIndexForSession(sessionId) {
  const hash = crypto.createHash('md5').update(sessionId).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return num % TOTAL_WORKERS;
}

// =============================================================================
// 👑 MASTER PROCESS (The API Router)
// =============================================================================
if (cluster.isPrimary) {
  console.log(`\n👑 Master Process ${process.pid} running`);
  console.log(`🔪 Forking ${TOTAL_WORKERS} workers...`);

  const workers = [];
  const requestMap = new Map(); // To track pending API responses

  // Fork workers
  for (let i = 0; i < TOTAL_WORKERS; i++) {
    const worker = cluster.fork({ WORKER_INDEX: i });
    workers.push(worker);

    // Listen for messages FROM workers
    worker.on('message', (msg) => {
      if (msg.type === 'API_RESPONSE') {
        const { requestId, success, data, error, statusCode = 500 } = msg;
        const pending = requestMap.get(requestId);
        if (pending) {
          if (success) pending.res.json(data);
          else pending.res.status(statusCode).json(error);
          requestMap.delete(requestId);
        }
      }
    });
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  // --- Helper to forward requests to workers ---
  const forwardToWorker = (sessionId, action, payload, res) => {
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });
    const targetIndex = getWorkerIndexForSession(sessionId);
    const requestId = crypto.randomUUID();
    
    // Save the response object to reply later
    requestMap.set(requestId, { res });
    workers[targetIndex].send({ type: 'EXECUTE_ACTION', action, requestId, sessionId, payload });
  };

  // --- ROUTES ---

  app.post('/session/start', (req, res) => forwardToWorker(req.body.session_id, 'start_session', {}, res));
  app.post('/session/:sessionId/send', (req, res) => forwardToWorker(req.params.sessionId, 'send_message', req.body, res));
  app.post('/session/:sessionId/disconnect', (req, res) => forwardToWorker(req.params.sessionId, 'disconnect', {}, res));
  app.get('/session/:sessionId/status', (req, res) => forwardToWorker(req.params.sessionId, 'get_status', {}, res));
  app.get('/health', (req, res) => res.json({ status: 'ok', workers: TOTAL_WORKERS, uptime: process.uptime() }));

  app.listen(PORT, () => console.log(`✅ Gateway API running on port ${PORT}`));

  cluster.on('exit', (worker) => {
    console.log(`💀 Worker ${worker.process.pid} died. Replacing...`);
    cluster.fork();
  });
}

// =============================================================================
// 👷 WORKER PROCESS
// =============================================================================
else {
  const WORKER_INDEX = parseInt(process.env.WORKER_INDEX);
  const sessions = new Map();
  const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
  console.log(`👷 Worker ${WORKER_INDEX} ready.`);

  process.on('message', async (msg) => {
    if (msg.type !== 'EXECUTE_ACTION') return;
    const { requestId, sessionId, action, payload } = msg;

    try {
      let result = { success: true };

      if (action === 'start_session') {
        result = await startWhatsAppSession(sessionId);
      }

      else if (action === 'send_message') {
        const session = sessions.get(sessionId);

        if (!session) {
          throw Object.assign(new Error('Session not available'), {
            statusCode: 503,
            clientResponse: { error: 'Session not available', reason: 'Session lost. Please restart.', action: 'POST /session/start' }
          });
        }

        if (session.status !== 'connected') {
          throw Object.assign(new Error('Session not connected'), {
            statusCode: 400,
            clientResponse: { error: 'Session not connected', status: session.status, qr: session.qr || undefined }
          });
        }

        const { to, text } = payload;
        if (!to || !text?.trim()) {
          throw Object.assign(new Error('Missing to/text'), { statusCode: 400, clientResponse: { error: 'to and text required' } });
        }

        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] OUTGOING → To: ${to} | "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
          const sentMsg = await session.socket.sendMessage(jid, { text }, { signal: controller.signal });
          clearTimeout(timeout);

          console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] SENT → ID: ${sentMsg.key.id}`);

          const receiptPromise = new Promise((resolve) => {
            const handler = (update) => {
              if (update.id === sentMsg.key.id) {
                session.socket.ev.off('messaging-history.set', handler);
                session.socket.ev.off('messages.update', handler);
                if (update.status === 'delivered' || update.status === 'read') {
                  console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] DELIVERED/READ → ${sentMsg.key.id}`);
                  resolve(true);
                }
                else if (update.status === 'failed') resolve(false);
              }
            };
            session.socket.ev.on('messages.update', handler);
            setTimeout(() => {
              session.socket.ev.off('messages.update', handler);
              console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] SENT (no receipt yet) → ${sentMsg.key.id}`);
              resolve(false);
            }, 8000);
          });

          const reallyDelivered = await receiptPromise;
          result = { success: true, id: sentMsg.key.id, delivered: reallyDelivered };

        } catch (err) {
          clearTimeout(timeout);
          if (err.name === 'AbortError') {
            throw Object.assign(new Error('Send timeout'), {
              statusCode: 504,
              clientResponse: { error: 'Timeout', reason: 'Recipient offline or slow network' }
            });
          }

          // Baileys error codes
          const code = err?.output?.statusCode;
          let reason = err.message;
          if (code === 403) reason = 'You are blocked or privacy settings prevent sending';
          if (code === 404) reason = 'Number does not exist on WhatsApp';
          if (code === 410) reason = 'Account logged out';

          throw Object.assign(new Error('Failed to send'), {
            statusCode: code === 404 || code === 403 ? 410 : 500,
            clientResponse: { error: 'Message failed', reason }
          });
        }
      }

      else if (action === 'disconnect') {
        const session = sessions.get(sessionId);
        if (session?.socket) await session.socket.logout();
        sessions.delete(sessionId);
        result = { success: true };
      }

      else if (action === 'get_status') {
        const session = sessions.get(sessionId);
        if (!session) throw Object.assign(new Error('Not found'), { statusCode: 404, clientResponse: { error: 'Session not found' } });
        result = { session_id: sessionId, status: session.status, phone: session.phone, qr: session.qr || undefined };
      }

      process.send({ type: 'API_RESPONSE', requestId, success: true, data: result });
    }
    catch (err) {
      console.error(`[Worker ${WORKER_INDEX}] [${sessionId || '??'}] ❌ ${err.message}`);

      let statusCode = 500;
      let response = { error: err.message || 'Unknown error' };

      if (err.statusCode && err.clientResponse) {
        statusCode = err.statusCode;
        response = err.clientResponse;
      }

      process.send({ type: 'API_RESPONSE', requestId, success: false, error: response, statusCode });
    }
  });

  // Rest of your existing functions (unchanged)
  async function startWhatsAppSession(sessionId) {
    if (sessions.has(sessionId)) return { success: true, status: sessions.get(sessionId).status };
    const sessionInfo = { socket: null, qr: null, status: 'initializing', phone: null };
    sessions.set(sessionId, sessionInfo);
    connectToWhatsApp(sessionId, sessionInfo);
    return { success: true, status: 'initializing' };
  }

  async function connectToWhatsApp(sessionId, sessionInfo) {
    try {
      const { state, saveCreds } = await useSupabaseAuthState(sessionId, logger);
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version, logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        printQRInTerminal: false,
      });

      sessionInfo.socket = sock;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          sessionInfo.qr = await qrcode.toDataURL(qr);
          sessionInfo.status = 'qr_ready';
          console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] QR CODE READY → Scan now!`);
          notifyBackend(sessionId, 'qr_ready', { qr: sessionInfo.qr });
        }
        
        if (connection === 'open') {
          sessionInfo.status = 'connected';
          sessionInfo.phone = sock.user?.id?.split(':')[0];
          console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] CONNECTED → Phone: ${sessionInfo.phone}`);
          notifyBackend(sessionId, 'connected', { phone: sessionInfo.phone });
        }
        
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === 401) { 
            sessions.delete(sessionId); 
            notifyBackend(sessionId, 'user_logout', {}); 
          }
          else setTimeout(() => connectToWhatsApp(sessionId, sessionInfo), 5000);
        }
      });

      const recentMessages = new Set();
      
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
    
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const msgId = msg.key.id;
        
            if (recentMessages.has(msgId)) continue;
            recentMessages.add(msgId);
            setTimeout(() => recentMessages.delete(msgId), 10000);

            const from = (msg.key.participant || msg.key.remoteJid).replace('@s.whatsapp.net', '').replace('@g.us', '');
            const text = msg.message.conversation || 
                        msg.message.extendedTextMessage?.text || 
                        '[Media/Message Type]';

            console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] INCOMING → From: ${from} | "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

            const realSender = msg.key.participant || msg.key.remoteJid;
            const content = msg.message.conversation || msg.message.extendedTextMessage?.text || 'media';
    
            notifyBackend(sessionId, 'message_received', {
                id: msg.key.id,
                from: realSender,
                message: content,
                pushName: msg.pushName || msg.senderName || null,
                timestamp: msg.messageTimestamp,
                participant: msg.key.participant || null,
                remoteJid: msg.key.remoteJid,
                messageType: Object.keys(msg.message || {})[0] || "unknown",
                raw: msg
            });
        }
      });
    

      sock.ev.on('creds.update', saveCreds);
    } catch (err) {
      console.error(`[Worker ${WORKER_INDEX}] Setup error:`, err);
      sessions.delete(sessionId);
    }
  }

  async function notifyBackend(sessionId, event, data) {
    try {
      let endpoint = '/whatsapp/webhook';
      if (event === 'qr_ready') endpoint += '/qr';
      else if (event === 'connected') endpoint += '/connected';
      else if (event === 'message_received') endpoint += '/message';
      else if (event === 'user_logout') endpoint += '/user-logout';
      await axios.post(`${BACKEND_URL}${endpoint}`, { session_id: sessionId, event, data });
    } catch (e) { /* ignore */ }
  }

  // Auto restore
  async function autoRestore() {
    const { data } = await supabase.from("whatsapp_sessions").select("id");
    if (!data) return;
    const mySessions = data.filter(s => getWorkerIndexForSession(s.id) === WORKER_INDEX);
    console.log(`[Worker ${WORKER_INDEX}] Restoring ${mySessions.length} sessions...`);
    for (const { id } of mySessions) {
      startWhatsAppSession(id);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  autoRestore();
}