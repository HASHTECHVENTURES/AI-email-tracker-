/**
 * Ensures the dev quick-fill Supabase Auth user exists (matches frontend app/auth/page.tsx).
 * Run from backend/: npm run ensure-dev-user
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../.env') });

const DEFAULT_EMAIL = 'email@gmail.com';
const DEFAULT_PASSWORD = 'Hello1234@';

async function findUserIdByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === target);
    if (u) return u.id;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const email = (process.env.DEV_AUTH_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.env.DEV_AUTH_PASSWORD ?? DEFAULT_PASSWORD;

  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('DEV_AUTH_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: email.split('@')[0] },
  });

  if (!createErr && created.user?.id) {
    console.log(`Created Auth user: ${email}`);
    return;
  }

  const msg = createErr?.message ?? '';
  if (!/already|registered|exists|duplicate/i.test(msg)) {
    console.error('createUser failed:', msg || createErr);
    process.exit(1);
  }

  const id = await findUserIdByEmail(supabase, email);
  if (!id) {
    console.error('User appears to exist but could not be listed. Check Supabase Auth → Users.');
    process.exit(1);
  }

  const { error: updErr } = await supabase.auth.admin.updateUserById(id, {
    password,
    email_confirm: true,
  });
  if (updErr) {
    console.error('updateUser failed:', updErr.message);
    process.exit(1);
  }
  console.log(`Updated password & confirmed email for: ${email}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
