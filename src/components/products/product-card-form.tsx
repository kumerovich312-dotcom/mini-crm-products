"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  CircleDashed,
  FileVideo,
  ImageIcon,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_COMPANY_ID } from "@/lib/constants";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Category, CustomField, Product, ProductCustomValue, ProductStatus } from "@/types/database";

const FALLBACK_COMPANY_PREFIX = "JWL";

type ProductFormMode = "new" | "edit";
type MediaStatus = "uploaded" | "processing" | "ready" | "failed";
type MediaType = "photo" | "video";

type MediaItem = {
  id: string;
  name: string;
  type: MediaType;
  size: string;
  status: MediaStatus;
  previewUrl?: string;
};

type ProductFormState = {
  name: string;
  sku: string;
  categoryId: string;
  price: string;
  stock: string;
  status: ProductStatus;
  description: string;
};

type CustomFieldValue = string | boolean;
type CustomFieldValuesState = Record<string, CustomFieldValue>;

type VisibilityState = {
  showInApi: boolean;
  hidden: boolean;
  draft: boolean;
};

const statusView: Record<MediaStatus, { label: string; className: string; icon: LucideIcon }> = {
  uploaded: {
    label: "uploaded",
    className: "bg-blue-50 text-blue-700",
    icon: CircleDashed,
  },
  processing: {
    label: "processing",
    className: "bg-amber-50 text-amber-700",
    icon: Loader2,
  },
  ready: {
    label: "ready",
    className: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  failed: {
    label: "failed",
    className: "bg-red-50 text-red-700",
    icon: XCircle,
  },
};

const selectClass =
  "h-10 rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function generateProductCode(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
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
        checked={checked}
        className="mt-1 size-4 accent-blue-600"
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function getFieldOptions(field: CustomField) {
  if (!Array.isArray(field.options)) {
    return [];
  }

  return field.options.filter((option): option is string => typeof option === "string");
}

function getCustomFieldInputId(field: CustomField) {
  return `custom-field-${field.id}`;
}

function isEmptyCustomFieldValue(field: CustomField, value: CustomFieldValue | undefined) {
  if (field.field_type === "boolean") {
    return value === undefined;
  }

  return String(value ?? "").trim() === "";
}

function getProductCustomValue(field: CustomField, row: ProductCustomValue): CustomFieldValue {
  if (field.field_type === "number") {
    return row.value_number === null ? "" : String(row.value_number);
  }

  if (field.field_type === "boolean") {
    return Boolean(row.value_boolean);
  }

  return row.value_text ?? "";
}

export function ProductCardForm({ mode, productId }: { mode: ProductFormMode; productId?: string }) {
  const router = useRouter();
  const isEdit = mode === "edit";
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const [categories, setCategories] = useState<Category[]>([]);
  const [companyPrefix, setCompanyPrefix] = useState(FALLBACK_COMPANY_PREFIX);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState(["кольцо", "золотое кольцо", "кольцо 585", "подарок девушке"]);
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<CustomField[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<CustomFieldValuesState>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<MediaItem[]>([
    {
      id: "mock-photo",
      name: "media-placeholder.webp",
      type: "photo",
      size: "placeholder",
      status: "ready",
    },
    {
      id: "mock-video",
      name: "video-placeholder.mp4",
      type: "video",
      size: "placeholder",
      status: "uploaded",
    },
  ]);
  const [form, setForm] = useState<ProductFormState>({
    name: "",
    sku: "",
    categoryId: "",
    price: "",
    stock: "0",
    status: isEdit ? "active" : "draft",
    description: "",
  });
  const [visibility, setVisibility] = useState<VisibilityState>({
    showInApi: true,
    hidden: false,
    draft: !isEdit,
  });

  const buildUniqueSku = useCallback(
    async (categoryId: string, prefix = companyPrefix) => {
      const category = categories.find((item) => item.id === categoryId);

      if (!category) {
        return "";
      }

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = `${prefix}-${category.code}-${generateProductCode(4)}`;
        const query = supabase
          .from("products")
          .select("id")
          .eq("company_id", DEFAULT_COMPANY_ID)
          .eq("sku", candidate);

        const { data, error } = productId ? await query.neq("id", productId) : await query;

        if (!error && (!data || data.length === 0)) {
          return candidate;
        }
      }

      return `${prefix}-${category.code}-${generateProductCode(4)}`;
    },
    [categories, companyPrefix, productId],
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    const [companyResult, categoriesResult, customFieldsResult] = await Promise.all([
      supabase.from("companies").select("sku_prefix").eq("id", DEFAULT_COMPANY_ID).maybeSingle(),
      supabase
        .from("categories")
        .select("*")
        .eq("company_id", DEFAULT_COMPANY_ID)
        .order("sort_order", { ascending: true }),
      supabase
        .from("custom_fields")
        .select("*")
        .eq("company_id", DEFAULT_COMPANY_ID)
        .order("sort_order", { ascending: true }),
    ]);

    const nextPrefix = companyResult.data?.sku_prefix ?? FALLBACK_COMPANY_PREFIX;
    const nextCategories = ((categoriesResult.data ?? []) as Category[]) ?? [];
    const nextCustomFields = ((customFieldsResult.data ?? []) as CustomField[]) ?? [];
    const defaultCustomValues = nextCustomFields.reduce<CustomFieldValuesState>((acc, field) => {
      if (field.field_type === "boolean") {
        acc[field.id] = false;
      }

      return acc;
    }, {});

    if (companyResult.error) {
      console.error(companyResult.error);
      setPageError(companyResult.error.message);
    }

    if (categoriesResult.error) {
      console.error(categoriesResult.error);
      setPageError(categoriesResult.error.message);
    }

    if (customFieldsResult.error) {
      console.error(customFieldsResult.error);
      setPageError("Не удалось загрузить пользовательские поля. Попробуйте обновить страницу.");
    }

    setCompanyPrefix(nextPrefix);
    setCategories(nextCategories);
    setCustomFieldDefinitions(nextCustomFields);
    setCustomFieldValues(defaultCustomValues);

    if (isEdit && productId) {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("company_id", DEFAULT_COMPANY_ID)
        .eq("id", productId)
        .maybeSingle();

      if (error) {
        console.error(error);
        setPageError(error.message);
      }

      if (data) {
        const product = data as Product;

        setForm({
          name: product.name,
          sku: product.sku,
          categoryId: product.category_id ?? "",
          price: String(product.price),
          stock: String(product.stock),
          status: product.status,
          description: product.description ?? "",
        });
        setKeywords(product.keywords);
        setVisibility({
          showInApi: product.api_visible,
          hidden: product.status === "hidden",
          draft: product.status === "draft",
        });
      }

      const { data: customValuesData, error: customValuesError } = await supabase
        .from("product_custom_values")
        .select("*")
        .eq("company_id", DEFAULT_COMPANY_ID)
        .eq("product_id", productId);

      if (customValuesError) {
        console.error(customValuesError);
        setPageError("Не удалось загрузить значения пользовательских полей.");
      }

      if (customValuesData) {
        const rows = customValuesData as ProductCustomValue[];
        const nextValues = rows.reduce<CustomFieldValuesState>((acc, row) => {
          const field = nextCustomFields.find((item) => item.id === row.custom_field_id);

          if (field) {
            acc[field.id] = getProductCustomValue(field, row);
          }

          return acc;
        }, { ...defaultCustomValues });

        setCustomFieldValues(nextValues);
      }
    }

    if (!isEdit && nextCategories[0]) {
      const category = nextCategories[0];
      const candidate = `${nextPrefix}-${category.code}-${generateProductCode(4)}`;

      setForm((current) => ({
        ...current,
        categoryId: category.id,
        sku: current.sku || candidate,
      }));
    }

    setIsLoading(false);
  }, [isEdit, productId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const previewUrls = previewUrlsRef.current;

    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.clear();
    };
  }, []);

  function updateForm(field: keyof ProductFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateCustomField(fieldId: string, value: CustomFieldValue) {
    setCustomFieldValues((current) => ({ ...current, [fieldId]: value }));
    setCustomFieldErrors((current) => ({ ...current, [fieldId]: "" }));
  }

  function updateVisibility(field: keyof VisibilityState, value: boolean) {
    setVisibility((current) => ({ ...current, [field]: value }));
  }

  function addKeyword() {
    const nextKeyword = keywordInput.trim();

    if (!nextKeyword || keywords.includes(nextKeyword)) {
      return;
    }

    setKeywords((current) => [...current, nextKeyword]);
    setKeywordInput("");
  }

  function removeKeyword(keyword: string) {
    setKeywords((current) => current.filter((item) => item !== keyword));
  }

  function addFiles(files: FileList | null, type: MediaType) {
    if (!files?.length) {
      return;
    }

    const nextMedia = Array.from(files).map((file) => {
      const previewUrl = type === "photo" ? URL.createObjectURL(file) : undefined;

      if (previewUrl) {
        previewUrlsRef.current.add(previewUrl);
      }

      return {
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        name: file.name,
        type,
        size: formatFileSize(file.size),
        status: "uploaded" as const,
        previewUrl,
      };
    });

    setMedia((current) => [...nextMedia, ...current]);
  }

  function removeMedia(id: string) {
    setMedia((current) => {
      const item = current.find((mediaItem) => mediaItem.id === id);

      if (item?.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previewUrlsRef.current.delete(item.previewUrl);
      }

      return current.filter((mediaItem) => mediaItem.id !== id);
    });
  }

  async function regenerateSku() {
    if (!form.categoryId) {
      setPageError("Выберите категорию для генерации артикула.");
      return;
    }

    const nextSku = await buildUniqueSku(form.categoryId);
    setForm((current) => ({ ...current, sku: nextSku }));
  }

  async function validateSkuUnique() {
    const query = supabase
      .from("products")
      .select("id")
      .eq("company_id", DEFAULT_COMPANY_ID)
      .eq("sku", form.sku.trim());

    const { data, error } = productId ? await query.neq("id", productId) : await query;

    if (error) {
      setPageError(error.message);
      return false;
    }

    return !data || data.length === 0;
  }

  function validateCustomFields() {
    const nextErrors: Record<string, string> = {};

    customFieldDefinitions.forEach((field) => {
      const value = customFieldValues[field.id];
      const isEmpty = isEmptyCustomFieldValue(field, value);

      if (field.is_required && isEmpty) {
        nextErrors[field.id] = "Обязательное поле";
        return;
      }

      if (isEmpty) {
        return;
      }

      if (field.field_type === "number" && Number.isNaN(Number(value))) {
        nextErrors[field.id] = "Введите число";
      }

      if (field.field_type === "select") {
        const options = getFieldOptions(field);

        if (!options.includes(String(value))) {
          nextErrors[field.id] = "Выберите значение из списка";
        }
      }
    });

    setCustomFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function buildCustomValuePayload(field: CustomField, productIdForValues: string) {
    const value = customFieldValues[field.id];

    return {
      company_id: DEFAULT_COMPANY_ID,
      product_id: productIdForValues,
      custom_field_id: field.id,
      value_text: field.field_type === "text" || field.field_type === "select" ? String(value ?? "").trim() : null,
      value_number: field.field_type === "number" ? Number(value) : null,
      value_boolean: field.field_type === "boolean" ? Boolean(value) : null,
      value_date: null,
    };
  }

  async function saveCustomFieldValues(productIdForValues: string) {
    for (const field of customFieldDefinitions) {
      const value = customFieldValues[field.id];
      const isEmpty = isEmptyCustomFieldValue(field, value);

      if (isEmpty) {
        const { error } = await supabase
          .from("product_custom_values")
          .delete()
          .eq("company_id", DEFAULT_COMPANY_ID)
          .eq("product_id", productIdForValues)
          .eq("custom_field_id", field.id);

        if (error) {
          console.error(error);
          return "Не удалось очистить значение пользовательского поля.";
        }

        continue;
      }

      const { data: existingValue, error: existingError } = await supabase
        .from("product_custom_values")
        .select("id")
        .eq("company_id", DEFAULT_COMPANY_ID)
        .eq("product_id", productIdForValues)
        .eq("custom_field_id", field.id)
        .maybeSingle();

      if (existingError) {
        console.error(existingError);
        return "Не удалось проверить значение пользовательского поля.";
      }

      const payload = buildCustomValuePayload(field, productIdForValues);
      const saveResult = existingValue
        ? await supabase
            .from("product_custom_values")
            .update(payload)
            .eq("id", existingValue.id)
            .eq("company_id", DEFAULT_COMPANY_ID)
        : await supabase.from("product_custom_values").insert(payload);

      if (saveResult.error) {
        console.error(saveResult.error);
        return "Не удалось сохранить значения пользовательских полей.";
      }
    }

    return null;
  }

  async function handleSave() {
    setPageError(null);
    setCustomFieldErrors({});

    if (!form.name.trim()) {
      setPageError("Название товара не должно быть пустым.");
      return;
    }

    if (!form.categoryId) {
      setPageError("Выберите категорию товара.");
      return;
    }

    if (!form.sku.trim()) {
      setPageError("SKU не должен быть пустым.");
      return;
    }

    if (!validateCustomFields()) {
      setPageError("Проверьте пользовательские поля.");
      return;
    }

    const isSkuUnique = await validateSkuUnique();

    if (!isSkuUnique) {
      setPageError("SKU уже используется внутри компании.");
      return;
    }

    setIsSaving(true);

    const nextStatus: ProductStatus = visibility.draft ? "draft" : visibility.hidden ? "hidden" : form.status;
    const payload = {
      company_id: DEFAULT_COMPANY_ID,
      category_id: form.categoryId,
      name: form.name.trim(),
      sku: form.sku.trim().toUpperCase(),
      price: Number(form.price) || 0,
      stock: Number(form.stock) || 0,
      status: nextStatus,
      description: form.description.trim() || null,
      keywords,
      api_visible: visibility.showInApi && !visibility.hidden,
    };

    const productResult =
      isEdit && productId
        ? await supabase
            .from("products")
            .update(payload)
            .eq("id", productId)
            .eq("company_id", DEFAULT_COMPANY_ID)
            .select("id")
            .single()
        : await supabase.from("products").insert(payload).select("id").single();

    if (productResult.error) {
      console.error(productResult.error);
      setPageError(productResult.error.message);
      setIsSaving(false);
      return;
    }

    const savedProductId = productResult.data?.id ?? productId;

    if (!savedProductId) {
      setPageError("Не удалось определить ID сохраненного товара.");
      setIsSaving(false);
      return;
    }

    const customValuesError = await saveCustomFieldValues(savedProductId);

    if (customValuesError) {
      setPageError(customValuesError);
      setIsSaving(false);
      return;
    }

    setIsSaving(false);
    router.push("/dashboard/products");
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        {pageError ? (
          <Card className="border-red-100 bg-red-50">
            <CardContent className="p-5 text-sm text-red-700">{pageError}</CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Фото и видео</CardTitle>
            <CardDescription>Медиа пока остаются локальными placeholder-карточками без upload.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <input
              ref={photoInputRef}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/heic,image/webp"
              multiple
              onChange={(event) => {
                addFiles(event.target.files, "photo");
                event.target.value = "";
              }}
            />
            <input
              ref={videoInputRef}
              className="hidden"
              type="file"
              accept="video/mp4,video/quicktime"
              multiple
              onChange={(event) => {
                addFiles(event.target.files, "video");
                event.target.value = "";
              }}
            />

            <div className="rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-6 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
                <UploadCloud className="size-6" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Перетащите фото или видео сюда</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Файлы показываются локально. Реальное хранение медиа будет подключено позже.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button type="button" onClick={() => photoInputRef.current?.click()}>
                  <ImageIcon />
                  Загрузить фото
                </Button>
                <Button type="button" variant="outline" onClick={() => videoInputRef.current?.click()}>
                  <FileVideo />
                  Загрузить видео
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {media.map((item) => {
                const StatusIcon = statusView[item.status].icon;

                return (
                  <div key={item.id} className="flex gap-3 rounded-lg border bg-white p-3">
                    <div className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-blue-50 text-blue-700">
                      {item.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt={item.name} className="size-full object-cover" src={item.previewUrl} />
                      ) : item.type === "photo" ? (
                        <ImageIcon className="size-6" />
                      ) : (
                        <Play className="size-6" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{item.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.type} · {item.size}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Удалить медиа"
                          onClick={() => removeMedia(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      <Badge className={cn("mt-2 gap-1", statusView[item.status].className)}>
                        <StatusIcon className={cn("size-3", item.status === "processing" && "animate-spin")} />
                        {statusView[item.status].label}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Основная информация</CardTitle>
            <CardDescription>Название, артикул, категория, цена, остаток и описание.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="name">Название</FieldLabel>
              <Input
                id="name"
                value={form.name}
                placeholder="Например: Кольцо Classic"
                onChange={(event) => updateForm("name", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="sku">SKU / Артикул</FieldLabel>
              <div className="flex gap-2">
                <Input id="sku" value={form.sku} onChange={(event) => updateForm("sku", event.target.value)} />
                <Button type="button" variant="outline" size="icon" onClick={() => void regenerateSku()}>
                  <RefreshCw />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="category">Категория</FieldLabel>
              <select
                className={selectClass}
                id="category"
                value={form.categoryId}
                onChange={(event) => updateForm("categoryId", event.target.value)}
              >
                <option value="">Выберите категорию</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name} ({category.code})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="price">Цена</FieldLabel>
              <Input
                id="price"
                value={form.price}
                placeholder="0"
                onChange={(event) => updateForm("price", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="stock">Остаток</FieldLabel>
              <Input
                id="stock"
                value={form.stock}
                placeholder="0"
                onChange={(event) => updateForm("stock", event.target.value)}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="status">Статус</FieldLabel>
              <select
                className={selectClass}
                id="status"
                value={form.status}
                onChange={(event) => updateForm("status", event.target.value as ProductStatus)}
              >
                <option value="active">Активен</option>
                <option value="hidden">Скрыт</option>
                <option value="out_of_stock">Нет в наличии</option>
                <option value="draft">Черновик</option>
              </select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="description">Описание</FieldLabel>
              <Textarea
                id="description"
                value={form.description}
                placeholder="Краткое описание товара для каталога и API"
                onChange={(event) => updateForm("description", event.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Дополнительные поля</CardTitle>
            <CardDescription>Поля загружаются из настроек пользовательских полей.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {isLoading ? (
              <div className="md:col-span-2">
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Загрузка пользовательских полей
                </span>
              </div>
            ) : null}
            {!isLoading && customFieldDefinitions.length === 0 ? (
              <p className="text-sm text-muted-foreground md:col-span-2">
                Пользовательские поля пока не настроены.
              </p>
            ) : null}
            {!isLoading
              ? customFieldDefinitions.map((field) => {
                  const inputId = getCustomFieldInputId(field);
                  const error = customFieldErrors[field.id];
                  const options = getFieldOptions(field);
                  const value = customFieldValues[field.id];
                  const shouldShowUnit = Boolean(field.unit) && ["number", "text"].includes(field.field_type);

                  return (
                    <div key={field.id} className="space-y-2">
                      <FieldLabel htmlFor={inputId}>
                        {field.name}
                        {field.is_required ? <span className="text-red-600"> *</span> : null}
                      </FieldLabel>
                      {field.field_type === "text" ? (
                        <Input
                          id={inputId}
                          value={String(value ?? "")}
                          onChange={(event) => updateCustomField(field.id, event.target.value)}
                        />
                      ) : null}
                      {field.field_type === "number" ? (
                        <Input
                          id={inputId}
                          type="number"
                          value={String(value ?? "")}
                          onChange={(event) => updateCustomField(field.id, event.target.value)}
                        />
                      ) : null}
                      {field.field_type === "select" ? (
                        <select
                          id={inputId}
                          className={selectClass}
                          value={String(value ?? "")}
                          onChange={(event) => updateCustomField(field.id, event.target.value)}
                        >
                          <option value="">Выберите значение</option>
                          {options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {field.field_type === "boolean" ? (
                        <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border bg-white px-3 text-sm">
                          <input
                            id={inputId}
                            type="checkbox"
                            className="size-4 accent-blue-600"
                            checked={Boolean(value)}
                            onChange={(event) => updateCustomField(field.id, event.target.checked)}
                          />
                          Да
                        </label>
                      ) : null}
                      {shouldShowUnit ? <p className="text-xs text-muted-foreground">Единица: {field.unit}</p> : null}
                      {error ? <p className="text-xs text-red-600">{error}</p> : null}
                    </div>
                  );
                })
              : null}
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Ключевые слова</CardTitle>
            <CardDescription>Используются для поиска и read-only API для ИИ.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="Добавить keyword"
              />
              <Button type="button" size="icon" onClick={addKeyword} aria-label="Добавить ключевое слово">
                <Plus />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {keywords.map((keyword) => (
                <Badge key={keyword} className="gap-1 bg-blue-50 text-blue-700">
                  {keyword}
                  <button
                    className="rounded-sm text-blue-700 hover:text-blue-900"
                    type="button"
                    onClick={() => removeKeyword(keyword)}
                    aria-label={`Удалить ${keyword}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Настройки отображения</CardTitle>
            <CardDescription>Контроль видимости товара в каталоге и API.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ToggleRow
              title="Показывать в API"
              description="Товар доступен внешнему AI-боту через read-only API."
              checked={visibility.showInApi}
              onChange={(checked) => updateVisibility("showInApi", checked)}
            />
            <ToggleRow
              title="Скрыть товар"
              description="Товар не показывается в публичной выдаче."
              checked={visibility.hidden}
              onChange={(checked) => updateVisibility("hidden", checked)}
            />
            <ToggleRow
              title="Черновик"
              description="Карточка сохранена, но еще не готова к публикации."
              checked={visibility.draft}
              onChange={(checked) => updateVisibility("draft", checked)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <Button type="button" onClick={() => void handleSave()} disabled={isSaving || isLoading}>
              {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
              Сохранить
            </Button>
            <Button asChild type="button" variant="outline">
              <Link href="/dashboard/products">Отмена</Link>
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
