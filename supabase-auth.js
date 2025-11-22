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
   SUPABASE AUTH STATE (FIXED)
============================================================ */
export async function useSupabaseAuthState(sessionId, logger, opts = {}) {
  
  // 1. LOAD DATA
  async function loadAuth() {
    console.log(`📂 [${sessionId}] Loading WhatsApp auth from DB...`);

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
      console.log(`⚠️ [${sessionId}] No auth data found - creating new session`);
      return { creds: initAuthCreds(), keys: {} };
    }

    console.log(`✅ [${sessionId}] Auth data loaded successfully`);
    return JSON.parse(JSON.stringify(data.auth_data), reviver);
  }

  let sessionCache = await loadAuth();
  let saveTimeout = null;
  let isSaving = false;

  // 2. SAVE DATA (WITH SMART DEBOUNCE)
  async function saveAuth(force = false) {
    // If already saving, don't queue another save
    if (isSaving) {
      console.log(`⏳ [${sessionId}] Save already in progress, queueing next save`);
      if (saveTimeout) clearTimeout(saveTimeout);
      if (!force) {
        saveTimeout = setTimeout(() => saveAuth(true), 2000);
      }
      return;
    }

    if (saveTimeout && !force) {
      // Already waiting, skip
      return;
    }

    if (saveTimeout) clearTimeout(saveTimeout);

    const executeSave = async () => {
      try {
        isSaving = true;
        console.log(`💾 [${sessionId}] Saving auth to DB...`);

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
        
        console.log(`✅ [${sessionId}] Auth saved successfully`);
        isSaving = false;
        saveTimeout = null;
      } catch (e) {
        console.error(`❌ [${sessionId}] Save Error:`, e.message);
        isSaving = false;
        // Retry in 3 seconds
        saveTimeout = setTimeout(executeSave, 3000);
      }
    };

    if (force) {
      // CRITICAL: Save immediately (e.g., after QR scan, after creds update)
      await executeSave();
    } else {
      // NON-CRITICAL: Wait 3 seconds before saving (shorter than before)
      console.log(`⏰ [${sessionId}] Scheduling auth save in 3s...`);
      saveTimeout = setTimeout(executeSave, 3000);
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
          // CRITICAL: Force immediate save for key updates
          // (These are sensitive - don't wait 3 seconds)
          console.log(`🔑 [${sessionId}] Keys updated - forcing immediate save`);
          saveAuth(true);
        },
      },
    },
    saveCreds: async () => {
      // CRITICAL: Always save credentials immediately
      // These are the most important - they determine if the session is valid
      console.log(`🔐 [${sessionId}] Credentials updated - forcing immediate save`);
      await saveAuth(true);
    },
  };
}