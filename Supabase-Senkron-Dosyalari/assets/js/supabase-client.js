/* Supabase browser client.
   Publishable key is intended for browser use. Database RLS policies protect data. */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://jqmfvinbzgqyitqquzdc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_uw979hCwS6xyLRTexQX55A_ZqgWidDs';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
