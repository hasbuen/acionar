import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

export const SUPABASE_URL = '__SUPABASE_URL__';
export const SUPABASE_ANON_KEY = '__SUPABASE_ANON_KEY__';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
