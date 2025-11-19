import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import qrcode from 'qrcode';
import makeWASocket, {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { supabase } from './supabaseClient.js';
import { useSupabaseAuthState } from './supabase-auth.js';
import pino from 'pino';
import cluster from 'cluster';
import os from 'os';
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
        const { requestId, success, data, error } = msg;
        const pending = requestMap.get(requestId);
        if (pending) {
          if (success) pending.res.json(data);
          else pending.res.status(500).json({ error });
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

    // Send to worker
    workers[targetIndex].send({
      type: 'EXECUTE_ACTION',
      action,
      requestId,
      sessionId,
      payload
    });
  };

  // --- ROUTES ---

  app.post('/session/start', (req, res) => {
    forwardToWorker(req.body.session_id, 'start_session', {}, res);
  });

  app.post('/session/:sessionId/send', (req, res) => {
    forwardToWorker(req.params.sessionId, 'send_message', req.body, res);
  });

  app.post('/session/:sessionId/disconnect', (req, res) => {
    forwardToWorker(req.params.sessionId, 'disconnect', {}, res);
  });

  app.get('/session/:sessionId/status', (req, res) => {
    forwardToWorker(req.params.sessionId, 'get_status', {}, res);
  });

  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      mode: 'cluster', 
      workers: TOTAL_WORKERS, 
      uptime: process.uptime() 
    });
  });

  app.listen(PORT, () => {
    console.log(`✅ Gateway API running on port ${PORT}`);
  });

  // Revive dead workers
  cluster.on('exit', (worker) => {
    console.log(`💀 Worker ${worker.process.pid} died. Replacing...`);
    cluster.fork();
  });
} 

// =============================================================================
// 👷 WORKER PROCESS (The WhatsApp Handler)
// =============================================================================
else {
  const WORKER_INDEX = parseInt(process.env.WORKER_INDEX);
  const sessions = new Map(); // Only holds sessions for THIS worker
  
  // Silent logger for production, 'info' for debug
  const logger = pino({ level: process.env.LOG_LEVEL || 'warn' }); 

  console.log(`👷 Worker ${WORKER_INDEX} ready.`);

  // Handle messages from Master
  process.on('message', async (msg) => {
    if (msg.type === 'EXECUTE_ACTION') {
      const { requestId, sessionId, action, payload } = msg;
      
      try {
        let result = { success: true };

        if (action === 'start_session') {
          result = await startWhatsAppSession(sessionId);
        }
        else if (action === 'send_message') {
            const session = sessions.get(sessionId);
            if (!session || session.status !== 'connected') throw new Error('Session not connected');
            const jid = payload.to.includes('@') ? payload.to : `${payload.to}@s.whatsapp.net`;
            const sent = await session.socket.sendMessage(jid, { text: payload.text });
            result = { success: true, id: sent.key.id };
        }
        else if (action === 'disconnect') {
            const session = sessions.get(sessionId);
            if (session?.socket) await session.socket.logout();
            sessions.delete(sessionId);
            result = { success: true };
        }
        else if (action === 'get_status') {
            const session = sessions.get(sessionId);
            if(!session) throw new Error('Session not found');
            result = { 
                session_id: sessionId, 
                status: session.status, 
                phone: session.phone, 
                qr: session.qr 
            };
        }

        // Reply to Master
        process.send({ type: 'API_RESPONSE', requestId, success: true, data: result });

      } catch (err) {
        process.send({ type: 'API_RESPONSE', requestId, success: false, error: err.message });
      }
    }
  });

  // --- CORE BAILEYS LOGIC ---

  async function startWhatsAppSession(sessionId) {
    if (sessions.has(sessionId)) {
      return { success: true, status: sessions.get(sessionId).status };
    }

    const sessionInfo = { socket: null, qr: null, status: 'initializing', phone: null, retries: 0 };
    sessions.set(sessionId, sessionInfo);
    
    // Non-blocking connect
    connectToWhatsApp(sessionId, sessionInfo);
    return { success: true, status: 'initializing' };
  }

  async function connectToWhatsApp(sessionId, sessionInfo) {
    try {
      const { state, saveCreds } = await useSupabaseAuthState(sessionId, logger);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false, // SAVE RAM
        syncFullHistory: false, // CRITICAL for scaling
        printQRInTerminal: false,
      });

      sessionInfo.socket = sock;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          const qrImage = await qrcode.toDataURL(qr);
          sessionInfo.qr = qrImage;
          sessionInfo.status = 'qr_ready';
          notifyBackend(sessionId, 'qr_ready', { qr: qrImage });
        }

        if (connection === 'open') {
          sessionInfo.status = 'connected';
          const phone = sock.user?.id?.split(':')[0];
          sessionInfo.phone = phone;
          console.log(`[Worker ${WORKER_INDEX}] [${sessionId}] ✅ Connected`);
          notifyBackend(sessionId, 'connected', { phone });
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === 401) {
             sessions.delete(sessionId);
             notifyBackend(sessionId, 'user_logout', {});
          } else {
             // Reconnect
             setTimeout(() => connectToWhatsApp(sessionId, sessionInfo), 3000);
          }
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const content = extractMessageContent(msg);
            notifyBackend(sessionId, 'message_received', {
                id: msg.key.id,
                from: msg.key.remoteJid,
                message: content
            });
        }
      });

      sock.ev.on('creds.update', saveCreds);

    } catch (err) {
      console.error(`[Worker ${WORKER_INDEX}] Setup Error:`, err.message);
      sessions.delete(sessionId);
    }
  }

  // --- UTILS ---
  
  function extractMessageContent(msg) {
    const m = msg.message;
    if (m.conversation) return { type: 'text', text: m.conversation };
    if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text };
    return { type: 'unknown' };
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

  // --- AUTO RESTORE (FILTERED) ---
  // Only restore sessions that belong to THIS worker
  async function autoRestore() {
    const { data } = await supabase.from("whatsapp_sessions").select("id");
    if (!data) return;

    const mySessions = data.filter(row => getWorkerIndexForSession(row.id) === WORKER_INDEX);
    console.log(`[Worker ${WORKER_INDEX}] Restoring ${mySessions.length} sessions...`);

    for (const row of mySessions) {
        startWhatsAppSession(row.id);
        await new Promise(r => setTimeout(r, 1000)); // Stagger start by 1s
    }
  }

  autoRestore();
}