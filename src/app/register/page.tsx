"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

function makeSlug(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${normalized || "company"}-${crypto.randomUUID().slice(0, 8)}`;
}

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [skuPrefix, setSkuPrefix] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!companyName.trim()) {
      setError("Название компании обязательно.");
      return;
    }

    if (!/^[A-Za-z0-9]{2,6}$/.test(skuPrefix.trim())) {
      setError("SKU prefix должен содержать 2-6 латинских букв или цифр.");
      return;
    }

    setIsLoading(true);

    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });

    if (signUpError) {
      logAppError("Register auth error", signUpError);
      setError(signUpError.message);
      setIsLoading(false);
      return;
    }

    const user = authData.user;

    if (!user) {
      setError("Пользователь создан, но сессия не получена. Проверьте email и войдите.");
      setIsLoading(false);
      return;
    }

    const { data: company, error: companyError } = await supabase
      .from("companies")
      .insert({
        name: companyName.trim(),
        slug: makeSlug(companyName),
        sku_prefix: skuPrefix.trim().toUpperCase(),
        currency: "KGS",
      })
      .select("id")
      .single();

    if (companyError) {
      logAppError("Register company error", companyError);
      setError(companyError.message);
      setIsLoading(false);
      return;
    }

    const { error: profileError } = await supabase.from("profiles").insert({
      id: user.id,
      user_id: user.id,
      company_id: company.id,
      email: email.trim(),
      full_name: fullName.trim() || null,
      role: "owner",
    });

    setIsLoading(false);

    if (profileError) {
      logAppError("Register profile error", profileError);
      setError(profileError.message);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BarChart3 className="size-6" />
          </div>
          <div>
            <CardTitle className="text-xl">Регистрация компании</CardTitle>
            <CardDescription>Создайте аккаунт владельца и первую компанию.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => void handleRegister(event)}>
            {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
            <Input value={email} placeholder="Email" type="email" onChange={(event) => setEmail(event.target.value)} />
            <Input
              value={password}
              placeholder="Пароль"
              type="password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <Input value={fullName} placeholder="Имя владельца" onChange={(event) => setFullName(event.target.value)} />
            <Input
              value={companyName}
              placeholder="Название компании"
              onChange={(event) => setCompanyName(event.target.value)}
            />
            <Input
              value={skuPrefix}
              placeholder="SKU prefix, например JWL"
              maxLength={6}
              onChange={(event) => setSkuPrefix(event.target.value)}
            />
            <Button className="w-full" disabled={isLoading}>
              {isLoading ? <Loader2 className="animate-spin" /> : null}
              Зарегистрироваться
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Уже есть аккаунт?{" "}
            <Link className="font-medium text-primary hover:underline" href="/login">
              Войти
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
