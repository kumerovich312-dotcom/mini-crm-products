"use client";

import { useState } from "react";
import { Bot, Building2, KeyRound, Save, Settings2, UploadCloud } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type SettingsState = {
  companyName: string;
  companySlug: string;
  skuPrefix: string;
  currency: string;
  productCodeLength: string;
  allowManualSku: boolean;
  photoLimit: string;
  videoLimit: string;
  maxPhotoSize: string;
  maxVideoSize: string;
  autoCompressPhotos: boolean;
  convertHeic: boolean;
  convertMov: boolean;
  keepOriginals: boolean;
  telegramShowGuide: boolean;
  telegramPhotoUpload: boolean;
  telegramVideoUpload: boolean;
  telegramMaxVideoLength: string;
  telegramLargeFileAction: string;
  apiEnabled: boolean;
  apiDailyLimit: string;
  apiShowHidden: boolean;
  apiShowOutOfStock: boolean;
};

const initialSettings: SettingsState = {
  companyName: "Jibek Jewelry",
  companySlug: "jibek-jewelry",
  skuPrefix: "JWL",
  currency: "KGS",
  productCodeLength: "4",
  allowManualSku: true,
  photoLimit: "10",
  videoLimit: "3",
  maxPhotoSize: "20",
  maxVideoSize: "300",
  autoCompressPhotos: true,
  convertHeic: true,
  convertMov: true,
  keepOriginals: false,
  telegramShowGuide: true,
  telegramPhotoUpload: true,
  telegramVideoUpload: true,
  telegramMaxVideoLength: "30",
  telegramLargeFileAction: "web_upload_link",
  apiEnabled: true,
  apiDailyLimit: "5000",
  apiShowHidden: false,
  apiShowOutOfStock: true,
};

const selectClass =
  "h-10 rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-white p-4">
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        className="mt-1 size-4 accent-blue-600"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState(initialSettings);
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsState, string>>>({});

  function updateSetting<K extends keyof SettingsState>(field: K, value: SettingsState[K]) {
    setSettings((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function isPositiveNumber(value: string) {
    return Number(value) > 0 && !Number.isNaN(Number(value));
  }

  function validateSettings() {
    const nextErrors: Partial<Record<keyof SettingsState, string>> = {};

    if (!settings.companyName.trim()) {
      nextErrors.companyName = "Название компании не должно быть пустым";
    }

    if (!/^[a-zA-Z0-9]{2,6}$/.test(settings.skuPrefix.trim())) {
      nextErrors.skuPrefix = "Префикс: латиница и цифры, 2–6 символов";
    }

    if (!["4", "5", "6"].includes(settings.productCodeLength)) {
      nextErrors.productCodeLength = "Длина кода товара должна быть 4, 5 или 6";
    }

    for (const field of ["photoLimit", "videoLimit", "maxPhotoSize", "maxVideoSize", "telegramMaxVideoLength", "apiDailyLimit"] as const) {
      if (!isPositiveNumber(settings[field])) {
        nextErrors[field] = "Значение должно быть положительным числом";
      }
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function saveSettings() {
    if (!validateSettings()) {
      return;
    }

    alert("Настройки сохранены локально. Подключение к базе будет позже.");
  }

  return (
    <>
      <PageHeader
        badge="Settings"
        title="Настройки"
        description="Базовые настройки компании, артикула, валюты и обработки медиа."
        action={
          <Button onClick={saveSettings}>
            <Save />
            Сохранить настройки
          </Button>
        }
      />

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
                onChange={(event) => updateSetting("companySlug", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="sku-prefix">Префикс артикула</FieldLabel>
              <Input
                id="sku-prefix"
                value={settings.skuPrefix}
                onChange={(event) => updateSetting("skuPrefix", event.target.value.toUpperCase())}
              />
              {errors.skuPrefix ? <p className="text-xs text-red-600">{errors.skuPrefix}</p> : null}
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
                <CardDescription>
                  Артикул формируется по шаблону: [ПРЕФИКС]-[КОД_КАТЕГОРИИ]-[КОД_ТОВАРА]
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-lg border bg-blue-50 p-4">
              <p className="text-sm text-muted-foreground">Пример артикула</p>
              <p className="mt-1 font-mono text-lg font-semibold text-blue-700">
                {settings.skuPrefix || "JWL"}-001-A7K9
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel htmlFor="sku-company-prefix">Префикс компании</FieldLabel>
                <Input
                  id="sku-company-prefix"
                  value={settings.skuPrefix}
                  onChange={(event) => updateSetting("skuPrefix", event.target.value.toUpperCase())}
                />
                {errors.skuPrefix ? <p className="text-xs text-red-600">{errors.skuPrefix}</p> : null}
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="product-code-length">Длина случайного кода товара</FieldLabel>
                <select
                  id="product-code-length"
                  className={selectClass}
                  value={settings.productCodeLength}
                  onChange={(event) => updateSetting("productCodeLength", event.target.value)}
                >
                  <option value="4">4 символа</option>
                  <option value="5">5 символов</option>
                  <option value="6">6 символов</option>
                </select>
                {errors.productCodeLength ? <p className="text-xs text-red-600">{errors.productCodeLength}</p> : null}
              </div>
            </div>
            <ToggleRow
              title="Разрешить ручное изменение SKU"
              description="Пользователь сможет редактировать артикул в карточке товара."
              checked={settings.allowManualSku}
              onChange={(checked) => updateSetting("allowManualSku", checked)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <SectionIcon icon={UploadCloud} />
              <div>
                <CardTitle>Медиа</CardTitle>
                <CardDescription>Ограничения и обработка фото/видео товара.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {[
                ["photoLimit", "Лимит фото на товар"],
                ["videoLimit", "Лимит видео на товар"],
                ["maxPhotoSize", "Максимальный размер фото, MB"],
                ["maxVideoSize", "Максимальный размер видео, MB"],
              ].map(([field, label]) => (
                <div key={field} className="space-y-2">
                  <FieldLabel htmlFor={field}>{label}</FieldLabel>
                  <Input
                    id={field}
                    value={settings[field as keyof SettingsState] as string}
                    onChange={(event) => updateSetting(field as keyof SettingsState, event.target.value)}
                  />
                  {errors[field as keyof SettingsState] ? (
                    <p className="text-xs text-red-600">{errors[field as keyof SettingsState]}</p>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ToggleRow
                title="Автосжатие фото"
                description="Сжимать фото без искажения внешнего вида товара."
                checked={settings.autoCompressPhotos}
                onChange={(checked) => updateSetting("autoCompressPhotos", checked)}
              />
              <ToggleRow
                title="Конвертация HEIC в JPG/WebP"
                description="Преобразовывать HEIC после загрузки."
                checked={settings.convertHeic}
                onChange={(checked) => updateSetting("convertHeic", checked)}
              />
              <ToggleRow
                title="Конвертация MOV в MP4"
                description="Преобразовывать MOV для web-просмотра."
                checked={settings.convertMov}
                onChange={(checked) => updateSetting("convertMov", checked)}
              />
              <ToggleRow
                title="Сохранять оригиналы файлов"
                description="Хранить исходные файлы вместе с обработанными версиями."
                checked={settings.keepOriginals}
                onChange={(checked) => updateSetting("keepOriginals", checked)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <SectionIcon icon={Bot} />
              <div>
                <CardTitle>Telegram-добавление</CardTitle>
                <CardDescription>Настройки будущего добавления товара через Telegram.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <ToggleRow
                title="Показывать инструкцию по съёмке"
                description="Перед загрузкой медиа показывать рекомендации."
                checked={settings.telegramShowGuide}
                onChange={(checked) => updateSetting("telegramShowGuide", checked)}
              />
              <ToggleRow
                title="Разрешить загрузку фото через Telegram"
                description="Пользователь сможет отправлять фото в бот."
                checked={settings.telegramPhotoUpload}
                onChange={(checked) => updateSetting("telegramPhotoUpload", checked)}
              />
              <ToggleRow
                title="Разрешить загрузку видео через Telegram"
                description="Пользователь сможет отправлять видео в бот."
                checked={settings.telegramVideoUpload}
                onChange={(checked) => updateSetting("telegramVideoUpload", checked)}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel htmlFor="telegram-video-length">Максимальная длина видео, секунд</FieldLabel>
                <Input
                  id="telegram-video-length"
                  value={settings.telegramMaxVideoLength}
                  onChange={(event) => updateSetting("telegramMaxVideoLength", event.target.value)}
                />
                {errors.telegramMaxVideoLength ? (
                  <p className="text-xs text-red-600">{errors.telegramMaxVideoLength}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="large-file-action">Если файл большой</FieldLabel>
                <select
                  id="large-file-action"
                  className={selectClass}
                  value={settings.telegramLargeFileAction}
                  onChange={(event) => updateSetting("telegramLargeFileAction", event.target.value)}
                >
                  <option value="web_upload_link">дать ссылку на web-загрузку</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <SectionIcon icon={KeyRound} />
              <div>
                <CardTitle>API для ИИ</CardTitle>
                <CardDescription>Настройки read-only API для внешнего AI-бота.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <ToggleRow
                title="Включить API"
                description="Разрешить read-only доступ к каталогу по API-ключу."
                checked={settings.apiEnabled}
                onChange={(checked) => updateSetting("apiEnabled", checked)}
              />
              <ToggleRow
                title="Показывать скрытые товары в API"
                description="По умолчанию выключено для аккуратной выдачи."
                checked={settings.apiShowHidden}
                onChange={(checked) => updateSetting("apiShowHidden", checked)}
              />
              <ToggleRow
                title="Показывать товары без остатка в API"
                description="Разрешить внешнему AI-боту видеть товары с нулевым остатком."
                checked={settings.apiShowOutOfStock}
                onChange={(checked) => updateSetting("apiShowOutOfStock", checked)}
              />
            </div>
            <div className="max-w-sm space-y-2">
              <FieldLabel htmlFor="api-daily-limit">Лимит запросов в день</FieldLabel>
              <Input
                id="api-daily-limit"
                value={settings.apiDailyLimit}
                onChange={(event) => updateSetting("apiDailyLimit", event.target.value)}
              />
              {errors.apiDailyLimit ? <p className="text-xs text-red-600">{errors.apiDailyLimit}</p> : null}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={saveSettings}>
            <Save />
            Сохранить настройки
          </Button>
        </div>
      </div>
    </>
  );
}
