import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || (!supabaseServiceRoleKey && !supabaseAnonKey)) {
  throw new Error("Supabase server env variables are missing.");
}

const supabaseKey = supabaseServiceRoleKey ?? supabaseAnonKey;

if (!supabaseKey) {
  throw new Error("Supabase server key is missing.");
}

export const supabaseServer = createClient(supabaseUrl, supabaseKey);
