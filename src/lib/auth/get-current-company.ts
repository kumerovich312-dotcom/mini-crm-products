import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

function isMissingSessionError(error: Error) {
  return error.name === "AuthSessionMissingError" || error.message.toLowerCase().includes("auth session missing");
}

export async function getCurrentCompanyId() {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    if (isMissingSessionError(userError)) {
      return null;
    }

    logAppError("Auth user error", userError);
    throw new Error(getErrorMessage(userError));
  }

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    logAppError("Auth/profile error", error);
    throw new Error(getErrorMessage(error));
  }

  const companyId = data?.company_id ?? null;

  if (!companyId) {
    return null;
  }

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();

  if (companyError) {
    logAppError("Auth/company error", companyError);
    throw new Error(getErrorMessage(companyError));
  }

  if (!company) {
    throw new Error("Компания текущего пользователя не найдена.");
  }

  return companyId;
}
