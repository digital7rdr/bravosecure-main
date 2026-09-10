import {createClient} from '@supabase/supabase-js';
import {decode as decodeBase64} from 'base64-arraybuffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SUPABASE_URL, SUPABASE_ANON_KEY} from '@utils/constants';
import {tokenVault} from '@services/tokenVault';

const url = SUPABASE_URL || 'https://placeholder.supabase.co';
const key = SUPABASE_ANON_KEY || 'placeholder-key';

export const supabase = createClient(url, key, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

// Supabase Auth is no longer used — custom API owns auth via Argon2id+JWT.
// We keep the supabase-js client around only for DB (`supabase.from`), storage,
// and realtime channels (e.g. SOS broadcasts).

// ─── User helpers ─────────────────────────────────────────────────────────────

export const userService = {
  getProfile: (userId: string) =>
    supabase.from('users').select('*').eq('id', userId).single(),

  updateProfile: (userId: string, updates: Record<string, unknown>) =>
    supabase.from('users').update(updates).eq('id', userId),

  /**
   * Upload a profile photo to the public `avatars` bucket and return a
   * cache-busted public URL (stored verbatim in `users.avatar_url`).
   *
   * DC-21 — the app no longer writes to storage with the anon key (which let
   * anyone with the extractable key overwrite any avatar). Instead it asks the
   * `avatar-upload-url` edge function for a service-role signed upload URL
   * scoped to THIS user's own path (the function verifies the Bravo JWT via
   * /auth/me), then uploads against that one-shot token. `base64` is the raw
   * image data (no data-URI prefix); we decode to bytes because RN's
   * `fetch(uri).blob()` is unreliable for local file URIs. The `?v=` suffix
   * forces <Image> to refetch after a re-upload to the same path.
   */
  uploadAvatar: async (userId: string, base64: string, mime: string): Promise<string> => {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const token = await tokenVault.getAccess();
    const {data: signed, error: signErr} = await supabase.functions.invoke<{
      path: string; token: string; publicUrl: string;
    }>('avatar-upload-url', {
      body: {ext},
      headers: token ? {Authorization: `Bearer ${token}`} : undefined,
    });
    if (signErr || !signed) {throw signErr ?? new Error('avatar_upload_url_failed');}
    const {error} = await supabase.storage
      .from('avatars')
      .uploadToSignedUrl(signed.path, signed.token, decodeBase64(base64), {
        contentType: mime,
        upsert: true,
      });
    if (error) {throw error;}
    return `${signed.publicUrl}?v=${Date.now()}`;
  },
};

// ─── Realtime ─────────────────────────────────────────────────────────────────
//
// FIX-14/§18 — there is deliberately NO `realtimeService` here any more.
//
// It used to export `subscribeToChannel` / `subscribeToTable` helpers that
// called `.subscribe()`. Nothing ever called them, and that was the only thing
// keeping the app on one socket: a single `.subscribe()` opens a SECOND,
// independent Phoenix WebSocket alongside the messenger transport — the exact
// duplicate-connection shape B-152 was fixed to remove and that the connection
// contract forbids ("one authenticated WebSocket").
//
// The one live realtime use is SOSScreen's `supabase.channel(...).send({type:
// 'broadcast'})`. On supabase-js 2.x an UNJOINED broadcast goes out over the
// HTTP broadcast endpoint, so it opens no socket. Keep it that way: if a
// feature genuinely needs Supabase realtime, route it through the central
// connection manager rather than re-adding a parallel subscribe helper.
