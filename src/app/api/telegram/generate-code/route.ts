import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getErrorMessage } from "@/lib/errors";

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase admin env variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const [type, token] = authorization.split(" ");

  return type?.toLowerCase() === "bearer" && token ? token : null;
}

function generateCode() {
  return Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
}

export async function POST(request: Request) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabaseAdmin();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return NextResponse.json({ error: userError?.message ?? "Unauthorized" }, { status: 401 });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("company_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    if (!profile?.company_id) {
      return NextResponse.json({ error: "Компания текущего пользователя не найдена." }, { status: 404 });
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("telegram_connection_codes")
        .insert({
          company_id: profile.company_id,
          code,
          expires_at: expiresAt,
        })
        .select("code, expires_at")
        .single();

      if (!error && data) {
        return NextResponse.json({ code: data.code, expires_at: data.expires_at });
      }

      if (error && !error.message.toLowerCase().includes("duplicate")) {
        throw error;
      }
    }

    return NextResponse.json({ error: "Не удалось сгенерировать код подключения." }, { status: 500 });
  } catch (error) {
    console.error("Telegram connection error", {
      stage: "generate_code",
      message: getErrorMessage(error),
      details: error,
    });

    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
