const SUPABASE_URL = 'https://vewjuebkgiejdvcgpexa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IzWakPXYrxIToGFDnNITlQ_GHwfWLQ6';

const { createClient } = window.supabase;
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getSession() {
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  return error;
}

export async function signOut() {
  await sb.auth.signOut();
}
