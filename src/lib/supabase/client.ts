/**
 * Browser-side Supabase client (anon key only — safe for the client bundle).
 * The anon key grants nothing by itself: all table access is governed by RLS.
 */
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
