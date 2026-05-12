import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getErrorMessage, logAppError } from "@/lib/errors";
import type { Company, Profile } from "@/types/database";

type OnboardCompanyPayload = {
  user_id?: unknown;
  email?: unknown;
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

  return `${normalized || "company"}-${crypto.randomUUID().slice(0, 8)}`;
}

function validationError(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as OnboardCompanyPayload;
    const userId = getRequiredString(payload, "user_id");
    const email = getRequiredString(payload, "email");
    const companyName = getRequiredString(payload, "company_name");
    const skuPrefix = getRequiredString(payload, "sku_prefix");
    const fullName = typeof payload.full_name === "string" && payload.full_name.trim() ? payload.full_name.trim() : null;

    if (!userId) {
      return validationError("user_id is required.");
    }

    if (!email) {
      return validationError("email is required.");
    }

    if (!companyName) {
      return validationError("company_name is required.");
    }

    if (!skuPrefix) {
      return validationError("sku_prefix is required.");
    }

    const supabase = getSupabaseAdmin();
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

    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
