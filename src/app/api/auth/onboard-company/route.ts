import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { createId } from "@/lib/create-id";
import { logAppError } from "@/lib/errors";
import { checkRateLimit, getRequestIp, rateLimitHeaders } from "@/lib/rate-limit";
import type { Company, Profile } from "@/types/database";

const ONBOARD_RATE_LIMIT = 20;
const ONBOARD_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

type OnboardCompanyPayload = {
  full_name?: unknown;
  company_name?: unknown;
  sku_prefix?: unknown;
};

type ExistingProfile = Profile & {
  company_id: string | null;
};

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

function getRequiredString(payload: OnboardCompanyPayload, key: keyof OnboardCompanyPayload) {
  const value = payload[key];

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return value.trim();
}

function makeSlug(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${normalized || "company"}-${createId().slice(0, 8)}`;
}

function validationError(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const [type, token] = authorization.split(" ");

  return type?.toLowerCase() === "bearer" && token ? token : null;
}

export async function POST(request: Request) {
  try {
    const rateLimit = checkRateLimit({
      key: `onboard-company:${getRequestIp(request)}`,
      limit: ONBOARD_RATE_LIMIT,
      windowMs: ONBOARD_RATE_LIMIT_WINDOW_MS,
    });

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: rateLimitHeaders(rateLimit, ONBOARD_RATE_LIMIT) },
      );
    }

    const token = getBearerToken(request);

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = (await request.json()) as OnboardCompanyPayload;
    const companyName = getRequiredString(payload, "company_name");
    const skuPrefix = getRequiredString(payload, "sku_prefix");
    const fullName = typeof payload.full_name === "string" && payload.full_name.trim() ? payload.full_name.trim() : null;

    if (!companyName) {
      return validationError("company_name is required.");
    }

    if (!skuPrefix) {
      return validationError("sku_prefix is required.");
    }

    const supabase = getSupabaseAdmin();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return NextResponse.json({ error: userError?.message ?? "Unauthorized" }, { status: 401 });
    }

    const userId = userData.user.id;
    const email = userData.user.email;

    if (!email) {
      return validationError("User email is required.");
    }

    const existingProfileResult = await supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle();

    if (existingProfileResult.error) {
      throw existingProfileResult.error;
    }

    if (existingProfileResult.data) {
      const existingProfile = existingProfileResult.data as ExistingProfile;
      const existingCompanyResult = existingProfile.company_id
        ? await supabase.from("companies").select("*").eq("id", existingProfile.company_id).maybeSingle()
        : { data: null, error: null };

      if (existingCompanyResult.error) {
        throw existingCompanyResult.error;
      }

      return NextResponse.json({
        profile: existingProfile,
        company: (existingCompanyResult.data as Company | null) ?? null,
        existing: true,
      });
    }

    const companyResult = await supabase
      .from("companies")
      .insert({
        name: companyName,
        slug: makeSlug(companyName),
        sku_prefix: skuPrefix.toUpperCase(),
        currency: "KGS",
      })
      .select("*")
      .single();

    if (companyResult.error) {
      throw companyResult.error;
    }

    const company = companyResult.data as Company;
    const profileResult = await supabase
      .from("profiles")
      .insert({
        id: userId,
        user_id: userId,
        company_id: company.id,
        email,
        full_name: fullName,
        role: "owner",
      })
      .select("*")
      .single();

    if (profileResult.error) {
      throw profileResult.error;
    }

    return NextResponse.json({
      profile: profileResult.data as Profile,
      company,
      existing: false,
    });
  } catch (error) {
    logAppError("Onboard company API error", error);

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
