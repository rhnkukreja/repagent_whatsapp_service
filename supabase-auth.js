import { supabase } from './supabaseClient.js';
import { proto, initAuthCreds } from '@whiskeysockets/baileys';
import { Buffer } from 'buffer';

const replacer = (key, value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'Buffer', data: value.toString('base64') };
  }
  return value;
};

const reviver = (key, value) => {
  if (typeof value === 'object' && value !== null && value.type === 'Buffer') {
    return Buffer.from(value.data, 'base64');
  }
  return value;
};

export async function useSupabaseAuthState(sessionId, logger, opts = {}) {
  let sessionCache = { creds: initAuthCreds(), keys: {} };
  let initialReadDone = false;

  async function writeToSupabase() {
    try {
      const authJson = JSON.parse(JSON.stringify(sessionCache, replacer));
      const row = {
        id: sessionId,
        user_id: opts.user_id || sessionId,
        status: 'connected',
        updated_at: new Date().toISOString(),
        auth_data: authJson,
      };

      const { error } = await supabase
        .from('whatsapp_sessions')
        .upsert(row, { onConflict: 'id' });

      if (error) throw error;
      console.log(`[${sessionId}] 💾 AUTH SAVED (creds + keys)`);
    } catch (err) {
      console.error(`[${sessionId}] ❌ FAILED TO SAVE AUTH`, err.message);
    }
  }

  const readFromSupabase = async () => {
    if (initialReadDone) return;
    console.log(`[${sessionId}] 📂 Loading auth from Supabase...`);

    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('auth_data')
      .eq('id', sessionId)
      .maybeSingle();

    if (error) {
      console.error(`[${sessionId}] ⚠️ Supabase read error`, error.message);
    } else if (data?.auth_data) {
      sessionCache = JSON.parse(JSON.stringify(data.auth_data), reviver);
      console.log(`[${sessionId}] ✅ AUTH LOADED (creds + keys)`);
    } else {
      console.log(`[${sessionId}] 🆕 No auth found → fresh login`);
      sessionCache = { creds: initAuthCreds(), keys: {} };
    }
    initialReadDone = true;
  };

  await readFromSupabase();

  return {
    state: {
      creds: sessionCache.creds,
      keys: {
        get: (type, ids) => {
          const data = sessionCache.keys[type] || {};
          return ids.reduce((dict, id) => {
            if (data[id]) dict[id] = data[id];
            return dict;
          }, {});
        },
        set: (data) => {
          console.log(`[${sessionId}] 🔑 Keys updated`);
          for (const type in data) {
            if (!sessionCache.keys[type]) sessionCache.keys[type] = {};
            Object.assign(sessionCache.keys[type], data[type]);
          }
          writeToSupabase();
        },
      },
    },
    saveCreds: async () => {
      console.log(`[${sessionId}] 🔐 Creds updated`);
      await writeToSupabase();
    },
  };
}