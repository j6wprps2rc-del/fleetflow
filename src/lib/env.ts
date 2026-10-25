/**
 * Environment presence checks.
 * IMPORTANT: this module reports whether a variable is SET — it must never
 * return or expose variable values.
 */
export const ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_MIGRATIONS',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY'
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];
export type EnvStatus = Record<EnvKey, boolean>;

export function envStatus(): EnvStatus {
  return {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    DATABASE_URL_MIGRATIONS: Boolean(process.env.DATABASE_URL_MIGRATIONS),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
}
