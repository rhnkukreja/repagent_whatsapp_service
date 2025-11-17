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
   SUPABASE AUTH STATE FOR BAILEYS
============================================================ */
export async function useSupabaseAuthState(sessionId, logger, opts = {}) {
  /* --------------------------------------
     ALWAYS LOAD AUTH DATA FROM SUPABASE
  ----------------------------------------- */
  async function loadAuth() {
    console.log(`📂 [${sessionId}] Loading WhatsApp auth from Supabase...`);

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
      console.log(`🆕 [${sessionId}] No saved login → starting fresh`);
      return { creds: initAuthCreds(), keys: {} };
    }

    console.log(`✅ [${sessionId}] WhatsApp session restored from Supabase`);
    return JSON.parse(JSON.stringify(data.auth_data), reviver);
  }

  let sessionCache = await loadAuth();

  /* --------------------------------------
     SAVE AUTH BACK TO SUPABASE
  ----------------------------------------- */
  async function saveAuth() {
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

      console.log(`💾 [${sessionId}] WhatsApp auth saved to Supabase`);
    } catch (e) {
      console.error(`❌ [${sessionId}] Error saving auth:`, e.message);
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
          console.log(`🔑 [${sessionId}] Keys updated`);
          for (const type in data) {
            sessionCache.keys[type] = sessionCache.keys[type] || {};
            Object.assign(sessionCache.keys[type], data[type]);
          }
          saveAuth();
        },
      },
    },
    saveCreds: async () => {
      console.log(`🔐 [${sessionId}] Creds updated`);
      await saveAuth();
    },
  };
}
