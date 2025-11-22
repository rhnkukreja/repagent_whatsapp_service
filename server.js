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

const TOTAL_WORKERS = parseInt(process.env.WORKERS || '4');
const PORT = 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const REQUEST_TIMEOUT = 30000;

function getWorkerIndexForSession(sessionId) {
  const hash = crypto.createHash('md5').update(sessionId).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return num % TOTAL_WORKERS;
}

if (cluster.isPrimary) {
  console.log(`\n👑 Master Process ${process.pid} running`);
  console.log(`🔪 Forking ${TOTAL_WORKERS} workers...`);

  const workers = [];
  const requestMap = new Map();
  const workerIndices = new Map();

  for (let i = 0; i < TOTAL_WORKERS; i++) {
    const worker = cluster.fork({ WORKER_INDEX: i });
    workers.push(worker);
    workerIndices.set(worker.process.pid, i);

    worker.on('message', (msg) => {
      if (msg.type === 'API_RESPONSE') {
        const { requestId, success, data, error, statusCode = 500 } = msg;
        const pending = requestMap.get(requestId);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
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

  const forwardToWorker = (sessionId, action, payload, res) => {
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });
    
    const targetIndex = getWorkerIndexForSession(sessionId);
    const requestId = crypto.randomUUID();

    const timeoutHandle = setTimeout(() => {
      requestMap.delete(requestId);
      if (!res.headersSent) {
        res.status(504).json({ error: 'Worker timeout' });
      }
    }, REQUEST_TIMEOUT);

    requestMap.set(requestId, { res, timeoutHandle });
    
    if (workers[targetIndex]) {
      workers[targetIndex].send({ type: 'EXECUTE_ACTION', action, requestId, sessionId, payload });
    } else {
      clearTimeout(timeoutHandle);
      requestMap.delete(requestId);
      res.status(503).json({ error: 'Worker not available' });
    }
  };

  app.post('/session/start', (req, res) => forwardToWorker(req.body.session_id, 'start_session', {}, res));
  app.post('/session/:sessionId/send', (req, res) => forwardToWorker(req.params.sessionId, 'send_message', req.body, res));
  app.post('/session/:sessionId/disconnect', (req, res) => forwardToWorker(req.params.sessionId, 'disconnect', {}, res));
  app.get('/session/:sessionId/status', (req, res) => forwardToWorker(req.params.sessionId, 'get_status', {}, res));
  app.get('/health', (req, res) => res.json({ status: 'ok', workers: TOTAL_WORKERS, uptime: process.uptime() }));

  app.listen(PORT, () => console.log(`✅ Gateway API running on port ${PORT}`));

  cluster.on('exit', (worker) => {
    const deadIndex = workerIndices.get(worker.process.pid);
    console.log(`💀 Worker ${deadIndex} died. Replacing...`);
    
    workerIndices.delete(worker.process.pid);

    const newWorker = cluster.fork({ WORKER_INDEX: deadIndex });
    workers[deadIndex] = newWorker;
    workerIndices.set(newWorker.process.pid, deadIndex);

    newWorker.on('message', (msg) => {
      if (msg.type === 'API_RESPONSE') {
        const { requestId, success, data, error, statusCode = 500 } = msg;
        const pending = requestMap.get(requestId);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
          if (success) pending.res.json(data);
          else pending.res.status(statusCode).json(error);
          requestMap.delete(requestId);
        }
      }
    });
  });
} else {
  const WORKER_INDEX = parseInt(process.env.WORKER_INDEX);
  const sessions = new Map();
  const logger = pino({ level: 'warn' });
  
  console.log(`👷 Worker ${WORKER_INDEX} started (PID: ${process.pid})`);

  process.on('message', async (msg) => {
    if (msg.type !== 'EXECUTE_ACTION') return;
    const { requestId, sessionId, action, payload } = msg;

    try {
      let result = { success: true };

      if (action === 'start_session') {
        result = await startWhatsAppSession(sessionId);
      } else if (action === 'send_message') {
        const session = sessions.get(sessionId);

        if (!session) {
          throw Object.assign(new Error('Session not available'), {
            statusCode: 503,
            clientResponse: { error: 'Session not available', action: 'POST /session/start' }
          });
        }

        const { to, text } = payload;
        if (!to || !text?.trim()) {
          throw Object.assign(new Error('Missing to/text'), { statusCode: 400, clientResponse: { error: 'to and text required' } });
        }

        // CHANGED: Don't fail if disconnected - wait for reconnect and retry
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

        let lastError = null;
        let sent = false;

        // Try to send for up to 60 seconds (reconnect should happen within this time)
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            // If not connected, wait a bit
            if (session.status !== 'connected') {
              console.log(`[${sessionId}] Not connected yet (${session.status}), waiting 2s...`);
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }

            // Try to send
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            try {
              const sentMsg = await session.socket.sendMessage(jid, { text }, { signal: controller.signal });
              clearTimeout(timeout);
              result = { success: true, id: sentMsg.key.id, delivered: true };
              sent = true;
              break; // Success!
            } catch (err) {
              clearTimeout(timeout);
              lastError = err;
              
              if (err.name === 'AbortError') {
                // Timeout - wait and retry
                console.log(`[${sessionId}] Send timeout, retrying...`);
                await new Promise(r => setTimeout(r, 2000));
              } else {
                // Other error - wait and retry
                console.log(`[${sessionId}] Send failed: ${err.message}, retrying...`);
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          } catch (err) {
            lastError = err;
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!sent) {
          throw Object.assign(new Error(`Failed to send after 60s`), {
            statusCode: 504,
            clientResponse: { error: 'Message send failed after retries', reason: lastError?.message }
          });
        }
      } else if (action === 'disconnect') {
        const session = sessions.get(sessionId);
        if (session?.socket) {
          try {
            await session.socket.logout();
          } catch (e) {
            console.error(`Logout error:`, e.message);
          }
        }
        sessions.delete(sessionId);
      } else if (action === 'get_status') {
        const session = sessions.get(sessionId);
        if (!session) throw Object.assign(new Error('Not found'), { statusCode: 404, clientResponse: { error: 'Session not found' } });
        result = { session_id: sessionId, status: session.status, phone: session.phone, qr: session.qr || undefined };
      }

      process.send({ type: 'API_RESPONSE', requestId, success: true, data: result });
    } catch (err) {
      console.error(`❌ ${err.message}`);
      let statusCode = 500;
      let response = { error: err.message };

      if (err.statusCode && err.clientResponse) {
        statusCode = err.statusCode;
        response = err.clientResponse;
      }

      process.send({ type: 'API_RESPONSE', requestId, success: false, error: response, statusCode });
    }
  });

  async function startWhatsAppSession(sessionId) {
    if (sessions.has(sessionId)) {
      const existing = sessions.get(sessionId);
      return { success: true, status: existing.status };
    }
    const sessionInfo = { 
      socket: null, 
      qr: null, 
      status: 'initializing', 
      phone: null, 
      reconnectAttempts: 0,
      lastConnectionTime: null,
      connectionStable: false // NEW: Track if connection is stable
    };
    sessions.set(sessionId, sessionInfo);
    connectToWhatsApp(sessionId, sessionInfo);
    return { success: true, status: 'initializing' };
  }

  async function connectToWhatsApp(sessionId, sessionInfo) {
    try {
      // Close old socket
      if (sessionInfo.socket) {
        try {
          await sessionInfo.socket.end();
        } catch (e) {
          console.log(`Old socket cleanup: ${e.message}`);
        }
      }

      const { state, saveCreds } = await useSupabaseAuthState(sessionId, logger);
      const { version } = await fetchLatestBaileysVersion();
      
      const sock = makeWASocket({
        version,
        logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: () => false,
        // STABILITY FIXES:
        retryRequestDelayMs: 100,
        maxMsToWaitForConnection: 30_000,
        emitOwnEvents: true,
      });

      sessionInfo.socket = sock;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          sessionInfo.qr = await qrcode.toDataURL(qr);
          sessionInfo.status = 'qr_ready';
          sessionInfo.connectionStable = false;
          console.log(`[${sessionId}] QR CODE READY`);
          await notifyBackend(sessionId, 'qr_ready', { qr: sessionInfo.qr });
        }

        if (connection === 'open') {
          sessionInfo.status = 'connected';
          sessionInfo.phone = sock.user?.id?.split(':')[0];
          sessionInfo.lastConnectionTime = Date.now();
          sessionInfo.connectionStable = false; // Not stable yet
          sessionInfo.reconnectAttempts = 0;
          
          console.log(`[${sessionId}] ✅ CONNECTED → ${sessionInfo.phone}`);
          
          // Wait 5 seconds to see if it's actually stable
          setTimeout(() => {
            if (sessionInfo.status === 'connected' && (Date.now() - sessionInfo.lastConnectionTime) > 5000) {
              sessionInfo.connectionStable = true;
              console.log(`[${sessionId}] ✅ Connection STABLE (held for 5s)`);
            }
          }, 5000);

          await notifyBackend(sessionId, 'connected', { phone: sessionInfo.phone });
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          console.log(`[${sessionId}] Connection closed. Code: ${code}`);

          // CODE 440 = DEVICE CONFLICT - DON'T GIVE UP
          if (code === 440) {
            // Just restart silently, don't delete session
            console.log(`[${sessionId}] Code 440 - restarting connection (expected behavior)`);
            setTimeout(() => connectToWhatsApp(sessionId, sessionInfo), 3000);
          }
          // CODE 401 = USER LOGOUT
          else if (code === 401) {
            console.log(`[${sessionId}] 401 Unauthorized - User logged out`);
            sessions.delete(sessionId);
            await notifyBackend(sessionId, 'user_logout', {});
          }
          // OTHER ERRORS = Normal retry
          else {
            if (sessionInfo.reconnectAttempts < 3) {
              sessionInfo.reconnectAttempts++;
              const delay = 2000 * sessionInfo.reconnectAttempts; // 2s, 4s, 6s
              console.log(`[${sessionId}] Reconnect ${sessionInfo.reconnectAttempts}/3 in ${delay}ms`);
              setTimeout(() => connectToWhatsApp(sessionId, sessionInfo), delay);
            } else {
              console.error(`[${sessionId}] Max reconnect attempts reached`);
              sessions.delete(sessionId);
            }
          }
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
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '[Media]';

          await notifyBackend(sessionId, 'message_received', {
            id: msg.key.id,
            from: msg.key.participant || msg.key.remoteJid,
            message: text,
            pushName: msg.pushName || null,
            timestamp: msg.messageTimestamp,
          });
        }
      });

      sock.ev.on('creds.update', saveCreds);
    } catch (err) {
      console.error(`Setup error: ${err.message}`);
      sessions.delete(sessionId);
    }
  }

  async function notifyBackend(sessionId, event, data) {
    let endpoint = '/whatsapp/webhook';
    if (event === 'qr_ready') endpoint += '/qr';
    else if (event === 'connected') endpoint += '/connected';
    else if (event === 'message_received') endpoint += '/message';
    else if (event === 'user_logout') endpoint += '/user-logout';

    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await axios.post(`${BACKEND_URL}${endpoint}`, { session_id: sessionId, event, data }, { timeout: 5000 });
        return;
      } catch (e) {
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async function autoRestore() {
    try {
      const { data } = await supabase.from('whatsapp_sessions').select('id');
      if (!data) return;
      const mySessions = data.filter(s => getWorkerIndexForSession(s.id) === WORKER_INDEX);
      console.log(`Restoring ${mySessions.length} sessions...`);
      for (const { id } of mySessions) {
        await startWhatsAppSession(id);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`Auto-restore error: ${err.message}`);
    }
  }

  autoRestore();
}