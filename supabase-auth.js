import { supabase } from './supabaseClient.js';
import { initAuthCreds } from '@whiskeysockets/baileys';
import { Buffer } from 'buffer';

/* ============================================================
   BUFFER (DE)SERIALIZER
============================================================ */
const replacer = (key, value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "Buffer", data: value.toString("base64") };
  }
  return value;
};

const reviver = (key, value) => {
  if (value && value.type === "Buffer") {
    return Buffer.from(value.data, "base64");
  }
  return value;
};

/* ============================================================
   SUPABASE AUTH STATE (OPTIMIZED FOR SCALING)
============================================================ */
export async function useSupabaseAuthState(sessionId, logger, opts = {}) {
  
  // 1. LOAD DATA
  async function loadAuth() {
    // console.log(`📂 [${sessionId}] Loading WhatsApp auth...`); 
    // (Commented out log to keep terminal clean with 100 users)

    const { data, error } = await supabase
      .from("whatsapp_sessions")
      .select("auth_data")
      .eq("id", sessionId)
      .maybeSingle();

    if (error) {
      console.error(`❌ [${sessionId}] Failed reading auth:`, error.message);
      return { creds: initAuthCreds(), keys: {} };
    }

    if (!data?.auth_data) {
      return { creds: initAuthCreds(), keys: {} };
    }

    return JSON.parse(JSON.stringify(data.auth_data), reviver);
  }

  let sessionCache = await loadAuth();
  let saveTimeout = null;

  // 2. SAVE DATA (WITH DEBOUNCE)
  // This prevents writing to DB 50 times a second. It batches writes.
  async function saveAuth(force = false) {
    if (saveTimeout && !force) return; // If waiting to save, skip
    if (saveTimeout) clearTimeout(saveTimeout);

    const executeSave = async () => {
      try {
        const serialized = JSON.parse(JSON.stringify(sessionCache, replacer));
        const row = {
          id: sessionId,
          user_id: opts.user_id || sessionId,
          status: "connected",
          updated_at: new Date().toISOString(),
          auth_data: serialized,
        };

        const { error } = await supabase
          .from("whatsapp_sessions")
          .upsert(row, { onConflict: "id" });

        if (error) throw error;
      } catch (e) {
        console.error(`❌ [${sessionId}] Save Error:`, e.message);
      }
    };

    if (force) {
      await executeSave();
    } else {
      // Wait 10 seconds before actually writing to DB
      saveTimeout = setTimeout(executeSave, 10000);
    }
  }

  return {
    state: {
      creds: sessionCache.creds,
      keys: {
        get: (type, ids) => {
          const data = sessionCache.keys[type] || {};
          return ids.reduce((out, id) => {
            if (data[id]) out[id] = data[id];
            return out;
          }, {});
        },
        set: (data) => {
          for (const type in data) {
            sessionCache.keys[type] = sessionCache.keys[type] || {};
            Object.assign(sessionCache.keys[type], data[type]);
          }
          // Soft save (throttled)
          saveAuth(false);
        },
      },
    },
    saveCreds: async () => {
      // Critical update (always save immediately)
      await saveAuth(true);
    },
  };
}