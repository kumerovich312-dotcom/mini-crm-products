"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Building2, Loader2, Save, Settings2, UploadCloud } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { selectClassName } from "@/components/ui/select-style";
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { Company } from "@/types/database";

type SettingsState = {
  companyName: string;
  companySlug: string;
  companyCode: string;
  technicalCompanyId: string;
  skuPrefix: string;
  skuRandomDigits: string;
  currency: string;
};

const initialSettings: SettingsState = {
  companyName: "",
  companySlug: "",
  companyCode: "",
  technicalCompanyId: "",
  skuPrefix: "JWL",
  skuRandomDigits: "4",
  currency: "KGS",
};

const selectClass = selectClassName;

function SectionIcon({ icon: Icon }: { icon: typeof Building2 }) {
  return (
    <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
      <Icon className="size-5" />
    </div>
  );
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label className="text-sm font-medium" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

function buildExampleSku(prefix: string, digits: string) {
  const length = Number(digits) || 4;
  const exampleDigits = "493718".slice(0, length);

  return `${prefix || "JWL"}-001-${exampleDigits}`;
}

export default function SettingsPage() {
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsState, string>>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTelegramConnected, setIsTelegramConnected] = useState(false);
  const [telegramCode, setTelegramCode] = useState<string | null>(null);
  const [telegramCodeExpiresAt, setTelegramCodeExpiresAt] = useState<string | null>(null);
  const [isGeneratingTelegramCode, setIsGeneratingTelegramCode] = useState(false);

  function updateSetting<K extends keyof SettingsState>(field: K, value: SettingsState[K]) {
    setSettings((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSuccessMessage(null);
  }

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);
    setSuccessMessage(null);

    try {
      const currentCompanyId = await getCurrentCompanyId();

      if (!currentCompanyId) {
        setPageError("Компания текущего пользователя не найдена. Войдите заново.");
        setCompanyId(null);
        setSettings(initialSettings);
        return;
      }

      setCompanyId(currentCompanyId);

      const [{ data, error }, connectionsResult] = await Promise.all([
        supabase
          .from("companies")
          .select("id, name, slug, sku_prefix, sku_random_digits, company_code, currency")
          .eq("id", currentCompanyId)
          .maybeSingle(),
        supabase
          .from("telegram_connections")
          .select("id")
          .eq("company_id", currentCompanyId)
          .eq("is_active", true)
          .limit(1),
      ]);

      if (error) {
        logAppError("Settings company load error", error);
        setPageError(error.message);
        return;
      }

      if (connectionsResult.error) {
        logAppError("Settings telegram connection load error", connectionsResult.error);
      }

      if (!data) {
        setPageError("Компания текущего пользователя не найдена.");
        return;
      }

      const company = data as Pick<
        Company,
        "id" | "name" | "slug" | "sku_prefix" | "sku_random_digits" | "company_code" | "currency"
      >;

      setSettings({
        companyName: company.name,
        companySlug: company.slug,
        companyCode: company.company_code ?? "",
        technicalCompanyId: company.id,
        skuPrefix: company.sku_prefix,
        skuRandomDigits: String(company.sku_random_digits ?? 4),
        currency: company.currency,
      });
      setIsTelegramConnected((connectionsResult.data?.length ?? 0) > 0);
    } catch (error) {
      logAppError("Settings load error", error);
      setPageError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  function validateSettings() {
    const nextErrors: Partial<Record<keyof SettingsState, string>> = {};

    if (!settings.companyName.trim()) {
      nextErrors.companyName = "Название компании не должно быть пустым";
    }

    if (!settings.companySlug.trim()) {
      nextErrors.companySlug = "Slug компании не должен быть пустым";
    }

    if (!/^[a-zA-Z0-9-]+$/.test(settings.companySlug.trim())) {
      nextErrors.companySlug = "Slug может содержать латиницу, цифры и дефис";
    }

    if (!/^[a-zA-Z0-9]{2,6}$/.test(settings.skuPrefix.trim())) {
      nextErrors.skuPrefix = "Префикс: латиница и цифры, 2-6 символов";
    }

    if (!["4", "5", "6"].includes(settings.skuRandomDigits)) {
      nextErrors.skuRandomDigits = "Длина случайной части SKU должна быть 4, 5 или 6";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function saveSettings() {
    if (!companyId || !validateSettings()) {
      return;
    }

    setIsSaving(true);
    setPageError(null);
    setSuccessMessage(null);

    try {
      const { data, error } = await supabase
        .from("companies")
        .update({
          name: settings.companyName.trim(),
          slug: settings.companySlug.trim().toLowerCase(),
          sku_prefix: settings.skuPrefix.trim().toUpperCase(),
          sku_random_digits: Number(settings.skuRandomDigits),
          currency: settings.currency,
        })
        .eq("id", companyId)
        .select("id, name, slug, sku_prefix, sku_random_digits, company_code, currency")
        .single();

      if (error) {
        logAppError("Settings company save error", error);
        setPageError(error.message);
        return;
      }

      const company = data as Pick<
        Company,
        "id" | "name" | "slug" | "sku_prefix" | "sku_random_digits" | "company_code" | "currency"
      >;

      setSettings({
        companyName: company.name,
        companySlug: company.slug,
        companyCode: company.company_code ?? settings.companyCode,
        technicalCompanyId: company.id,
        skuPrefix: company.sku_prefix,
        skuRandomDigits: String(company.sku_random_digits),
        currency: company.currency,
      });
      setSuccessMessage("Настройки сохранены");
    } catch (error) {
      logAppError("Settings company save exception", error);
      setPageError(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function generateTelegramCode() {
    setIsGeneratingTelegramCode(true);
    setPageError(null);
    setSuccessMessage(null);
    setTelegramCode(null);
    setTelegramCodeExpiresAt(null);

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) {
        throw sessionError;
      }

      const token = sessionData.session?.access_token;

      if (!token) {
        setPageError("Сессия пользователя не найдена. Войдите заново.");
        return;
      }

      const response = await fetch("/api/telegram/generate-code", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const payload = (await response.json()) as { code?: string; expires_at?: string; error?: string };

      if (!response.ok || !payload.code) {
        throw new Error(payload.error ?? "Не удалось сгенерировать код подключения.");
      }

      setTelegramCode(payload.code);
      setTelegramCodeExpiresAt(payload.expires_at ?? null);
      setSuccessMessage("Код подключения создан");
    } catch (error) {
      logAppError("Settings telegram code error", error);
      setPageError(getErrorMessage(error));
    } finally {
      setIsGeneratingTelegramCode(false);
    }
  }

  const exampleSku = buildExampleSku(settings.skuPrefix, settings.skuRandomDigits);

  return (
    <>
      <PageHeader
        badge="Settings"
        title="Настройки"
        description="Базовые настройки компании, артикула и валюты."
        action={
          <Button onClick={() => void saveSettings()} disabled={isLoading || isSaving}>
            {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
            Сохранить настройки
          </Button>
        }
      />

      {pageError ? (
        <Card className="mb-6 border-red-100 bg-red-50">
          <CardContent className="p-5 text-sm text-red-700">{pageError}</CardContent>
        </Card>
      ) : null}

      {successMessage ? (
        <Card className="mb-6 border-emerald-100 bg-emerald-50">
          <CardContent className="p-5 text-sm text-emerald-700">{successMessage}</CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" />
            Загрузка настроек
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <SectionIcon icon={Building2} />
                <div>
                  <CardTitle>Компания</CardTitle>
                  <CardDescription>Основные данные компании для каталога и артикулов.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel htmlFor="company-code">Номер компании</FieldLabel>
                <Input id="company-code" value={settings.companyCode || "Будет создан после миграции"} disabled />
                <p className="text-xs text-muted-foreground">Красивый публичный номер. UUID компании не заменяет.</p>
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="company-id">Технический ID</FieldLabel>
                <Input id="company-id" value={settings.technicalCompanyId} disabled />
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="company-name">Название компании</FieldLabel>
                <Input
                  id="company-name"
                  value={settings.companyName}
                  onChange={(event) => updateSetting("companyName", event.target.value)}
                />
                {errors.companyName ? <p className="text-xs text-red-600">{errors.companyName}</p> : null}
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="company-slug">Slug компании</FieldLabel>
                <Input
                  id="company-slug"
                  value={settings.companySlug}
                  onChange={(event) => updateSetting("companySlug", event.target.value.toLowerCase())}
                />
                {errors.companySlug ? <p className="text-xs text-red-600">{errors.companySlug}</p> : null}
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="currency">Валюта</FieldLabel>
                <select
                  id="currency"
                  className={selectClass}
                  value={settings.currency}
                  onChange={(event) => updateSetting("currency", event.target.value)}
                >
                  <option value="KGS">KGS</option>
                  <option value="KZT">KZT</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <SectionIcon icon={Settings2} />
                <div>
                  <CardTitle>Артикулы</CardTitle>
                  <CardDescription>Новые товары используют шаблон [ПРЕФИКС]-[КОД_КАТЕГОРИИ]-[СЛУЧАЙНЫЕ_ЦИФРЫ].</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-lg border bg-blue-50 p-4">
                <p className="text-sm text-muted-foreground">Пример артикула</p>
                <p className="mt-1 font-mono text-lg font-semibold text-blue-700">{exampleSku}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel htmlFor="sku-prefix">Префикс компании</FieldLabel>
                  <Input
                    id="sku-prefix"
                    value={settings.skuPrefix}
                    onChange={(event) => updateSetting("skuPrefix", event.target.value.toUpperCase())}
                  />
                  {errors.skuPrefix ? <p className="text-xs text-red-600">{errors.skuPrefix}</p> : null}
                </div>
                <div className="space-y-2">
                  <FieldLabel htmlFor="sku-random-digits">Длина случайной части SKU</FieldLabel>
                  <select
                    id="sku-random-digits"
                    className={selectClass}
                    value={settings.skuRandomDigits}
                    onChange={(event) => updateSetting("skuRandomDigits", event.target.value)}
                  >
                    <option value="4">4 цифры</option>
                    <option value="5">5 цифр</option>
                    <option value="6">6 цифр</option>
                  </select>
                  {errors.skuRandomDigits ? <p className="text-xs text-red-600">{errors.skuRandomDigits}</p> : null}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <SectionIcon icon={UploadCloud} />
                <div>
                  <CardTitle>Медиа и API</CardTitle>
                  <CardDescription>Эти настройки будут подключены отдельным этапом.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border bg-slate-50 p-4 text-sm text-muted-foreground">
                Переключатели обработки медиа, Telegram и лимитов API скрыты как рабочие настройки, чтобы не создавать
                ощущение сохранения без влияния на продукт. Сейчас реально сохраняются настройки компании, валюты и SKU.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <SectionIcon icon={Bot} />
                <div>
                  <CardTitle>Telegram-бот</CardTitle>
                  <CardDescription>Подключение Telegram-чата к текущей компании.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border bg-slate-50 p-4 text-sm">
                <span className="font-medium">Статус: </span>
                <span className={isTelegramConnected ? "text-emerald-700" : "text-muted-foreground"}>
                  {isTelegramConnected ? "подключён" : "не подключён"}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={isGeneratingTelegramCode}
                onClick={() => void generateTelegramCode()}
              >
                {isGeneratingTelegramCode ? <Loader2 className="animate-spin" /> : <Bot />}
                Сгенерировать код подключения
              </Button>
              {telegramCode ? (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
                  <p className="text-sm text-muted-foreground">Отправьте этот код боту:</p>
                  <p className="mt-1 font-mono text-2xl font-semibold text-blue-700">{telegramCode}</p>
                  {telegramCodeExpiresAt ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Код действует до {new Intl.DateTimeFormat("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(telegramCodeExpiresAt))}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">Токен и секрет webhook в интерфейсе не отображаются.</p>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => void saveSettings()} disabled={isSaving}>
              {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
              Сохранить настройки
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
