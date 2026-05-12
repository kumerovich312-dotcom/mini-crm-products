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
import { selectClassName } from "@/components/ui/select-style";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { createId } from "@/lib/create-id";
import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Category, CustomField, Product, ProductCustomValue, ProductMedia, ProductStatus } from "@/types/database";

const FALLBACK_COMPANY_PREFIX = "JWL";
const MEDIA_BUCKET = "product-media";
const MAX_PHOTO_SIZE = 20 * 1024 * 1024;
const MAX_VIDEO_SIZE = 300 * 1024 * 1024;
const MAX_PHOTOS = 10;
const MAX_VIDEOS = 3;
const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic"];
const VIDEO_EXTENSIONS = [".mp4", ".mov"];

type ProductFormMode = "new" | "edit";
type MediaStatus = "uploaded" | "processing" | "ready" | "failed";
type MediaType = "photo" | "video";

type MediaItem = {
  id: string;
  name: string;
  type: MediaType;
  size: string;
  status: MediaStatus;
  source: "existing" | "pending";
  error?: string;
  file?: File;
  previewUrl?: string;
  originalUrl?: string;
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

const selectClass = selectClassName;

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");

  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function sanitizeStorageBase(value: string) {
  return value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();
}

function createShortId() {
  const id = createId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

  return (id || Math.random().toString(36).slice(2)).slice(0, 6);
}

function createMediaStorageFileName(file: File, sku?: string) {
  const extension = getFileExtension(file.name) || (file.type === "image/png" ? ".png" : ".jpg");
  const base = sanitizeStorageBase(sku ?? "") || "media";

  return `${base}-${createShortId()}${extension}`;
}

function isSupportedFile(file: File, type: MediaType) {
  const extension = getFileExtension(file.name);

  if (type === "photo") {
    return PHOTO_MIME_TYPES.includes(file.type) || PHOTO_EXTENSIONS.includes(extension);
  }

  return VIDEO_MIME_TYPES.includes(file.type) || VIDEO_EXTENSIONS.includes(extension);
}

function getFileLimitError(file: File, type: MediaType) {
  if (!isSupportedFile(file, type)) {
    return type === "photo"
      ? "Формат фото не поддерживается. Разрешены jpg, jpeg, png, webp, heic."
      : "Формат видео не поддерживается. Разрешены mp4 и mov.";
  }

  if (type === "photo" && file.size > MAX_PHOTO_SIZE) {
    return "Фото слишком большое. Максимальный размер фото — 20 MB.";
  }

  if (type === "video" && file.size > MAX_VIDEO_SIZE) {
    return "Видео слишком большое. Максимальный размер видео — 300 MB.";
  }

  return null;
}

function getErrorField(error: unknown, field: "details" | "statusCode") {
  if (typeof error === "object" && error !== null && field in error) {
    return (error as Record<string, unknown>)[field];
  }

  return undefined;
}

function logMediaError({
  stage,
  file,
  path,
  error,
}: {
  stage: "storage_upload" | "product_media_insert";
  file: File;
  path: string;
  error: unknown;
}) {
  console.error("Product media upload error", {
    stage,
    fileName: file.name,
    fileSize: file.size,
    bucket: MEDIA_BUCKET,
    path,
    errorMessage: getErrorMessage(error),
    errorDetails: getErrorField(error, "details"),
    errorStatusCode: getErrorField(error, "statusCode"),
  });
}

function generateSkuDigits(length: number) {
  const max = 10 ** length;

  return Math.floor(Math.random() * max)
    .toString()
    .padStart(length, "0");
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
  disabled = false,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-white p-4",
        disabled && "cursor-not-allowed bg-slate-50 text-muted-foreground opacity-70",
      )}
    >
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} className="mt-1" disabled={disabled} onCheckedChange={onChange} />
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

function mapProductMedia(row: ProductMedia): MediaItem {
  const mediaUrl = row.processed_url ?? row.original_url;

  return {
    id: row.id,
    name: row.file_name ?? "media",
    type: row.media_type,
    size: row.file_size_bytes ? formatFileSize(row.file_size_bytes) : "unknown",
    status: row.status,
    source: "existing",
    previewUrl: row.thumbnail_url ?? mediaUrl,
    originalUrl: row.original_url,
  };
}

export function ProductCardForm({ mode, productId }: { mode: ProductFormMode; productId?: string }) {
  const router = useRouter();
  const isEdit = mode === "edit";
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const [categories, setCategories] = useState<Category[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyPrefix, setCompanyPrefix] = useState(FALLBACK_COMPANY_PREFIX);
  const [skuRandomDigits, setSkuRandomDigits] = useState(4);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<CustomField[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<CustomFieldValuesState>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [isEditableProduct, setIsEditableProduct] = useState(!isEdit);
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
    showInApi: isEdit,
  });

  const buildUniqueSku = useCallback(
    async (categoryId: string, prefix = companyPrefix, randomDigits = skuRandomDigits) => {
      if (!companyId) {
        return "";
      }

      const category = categories.find((item) => item.id === categoryId);

      if (!category) {
        return "";
      }

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = `${prefix}-${category.code}-${generateSkuDigits(randomDigits)}`.toUpperCase();
        const query = supabase
          .from("products")
          .select("id")
          .eq("company_id", companyId)
          .eq("sku", candidate);

        const { data, error } = productId ? await query.neq("id", productId) : await query;

        if (!error && (!data || data.length === 0)) {
          return candidate;
        }
      }

      return null;
    },
    [categories, companyId, companyPrefix, productId, skuRandomDigits],
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);
    setIsEditableProduct(!isEdit);

    let currentCompanyId: string | null = null;

    try {
      currentCompanyId = await getCurrentCompanyId();
    } catch (error) {
      logAppError("Product form profile error", error);
      setPageError(getErrorMessage(error));
      setIsLoading(false);
      return;
    }

    if (!currentCompanyId) {
      setPageError("Компания текущего пользователя не найдена. Войдите заново.");
      setIsLoading(false);
      return;
    }

    setCompanyId(currentCompanyId);

    const [companyResult, categoriesResult, customFieldsResult] = await Promise.all([
      supabase.from("companies").select("sku_prefix, sku_random_digits").eq("id", currentCompanyId).maybeSingle(),
      supabase
        .from("categories")
        .select("*")
        .eq("company_id", currentCompanyId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("custom_fields")
        .select("*")
        .eq("company_id", currentCompanyId)
        .order("sort_order", { ascending: true }),
    ]);

    const nextPrefix = companyResult.data?.sku_prefix ?? FALLBACK_COMPANY_PREFIX;
    const nextSkuRandomDigits = companyResult.data?.sku_random_digits ?? 4;
    const nextCategories = ((categoriesResult.data ?? []) as Category[]) ?? [];
    const nextCustomFields = ((customFieldsResult.data ?? []) as CustomField[]) ?? [];
    const defaultCustomValues = nextCustomFields.reduce<CustomFieldValuesState>((acc, field) => {
      if (field.field_type === "boolean") {
        acc[field.id] = false;
      }

      return acc;
    }, {});

    if (companyResult.error) {
      logAppError("Product form company error", companyResult.error);
      setPageError(companyResult.error.message);
    }

    if (categoriesResult.error) {
      logAppError("Product form categories error", categoriesResult.error);
      setPageError(categoriesResult.error.message);
    }

    if (customFieldsResult.error) {
      logAppError("Product form custom fields error", customFieldsResult.error);
      setPageError("Не удалось загрузить пользовательские поля. Попробуйте обновить страницу.");
    }

    setCompanyPrefix(nextPrefix);
    setSkuRandomDigits(nextSkuRandomDigits);
    setCategories(nextCategories);
    setCustomFieldDefinitions(nextCustomFields);
    setCustomFieldValues(defaultCustomValues);

    if (isEdit && productId) {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("company_id", currentCompanyId)
        .eq("id", productId)
        .maybeSingle();

      if (error) {
        logAppError("Product form product load error", error);
        setPageError(error.message);
      }

      if (data) {
        const product = data as Product;
        setIsEditableProduct(true);

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
          showInApi: product.status === "hidden" || product.status === "draft" ? false : product.is_visible_in_api,
        });
      } else if (!error) {
        setIsEditableProduct(false);
        setPageError("Товар не найден в текущей компании.");
      }

      const { data: customValuesData, error: customValuesError } = await supabase
        .from("product_custom_values")
        .select("*")
        .eq("company_id", currentCompanyId)
        .eq("product_id", productId);

      if (customValuesError) {
        logAppError("Product form custom values error", customValuesError);
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

      const { data: mediaData, error: mediaError } = await supabase
        .from("product_media")
        .select("*")
        .eq("company_id", currentCompanyId)
        .eq("product_id", productId)
        .order("sort_order", { ascending: true });

      if (mediaError) {
        logAppError("Product form media load error", mediaError);
        setPageError("Не удалось загрузить медиа товара.");
      }

      if (mediaData) {
        setMedia(((mediaData ?? []) as ProductMedia[]).map(mapProductMedia));
      }
    }

    if (!isEdit && nextCategories[0]) {
      const category = nextCategories[0];
      let candidate: string | null = null;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const nextSku = `${nextPrefix}-${category.code}-${generateSkuDigits(nextSkuRandomDigits)}`.toUpperCase();
        const { data, error } = await supabase
          .from("products")
          .select("id")
          .eq("company_id", currentCompanyId)
          .eq("sku", nextSku);

        if (!error && (!data || data.length === 0)) {
          candidate = nextSku;
          break;
        }
      }

      setForm((current) => ({
        ...current,
        categoryId: category.id,
        sku: current.sku || candidate || "",
      }));

      if (!candidate) {
        setPageError("Не удалось сгенерировать уникальный артикул, попробуйте ещё раз");
      }
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

    if (field === "status") {
      const nextStatus = value as ProductStatus;

      setVisibility((current) => ({
        showInApi: nextStatus === "hidden" || nextStatus === "draft" ? false : current.showInApi,
      }));
    }
  }

  function updateCustomField(fieldId: string, value: CustomFieldValue) {
    setCustomFieldValues((current) => ({ ...current, [fieldId]: value }));
    setCustomFieldErrors((current) => ({ ...current, [fieldId]: "" }));
  }

  function updateVisibility(field: keyof VisibilityState | "hidden" | "draft", value: boolean) {
    if (field === "hidden") {
      setVisibility((current) => ({
        showInApi: value ? false : current.showInApi,
      }));
      setForm((current) => ({ ...current, status: value ? "hidden" : "active" }));
      return;
    }

    if (field === "draft") {
      setVisibility((current) => ({
        showInApi: value ? false : current.showInApi,
      }));
      setForm((current) => ({ ...current, status: value ? "draft" : "active" }));
      return;
    }

    if (form.status === "hidden" || form.status === "draft") {
      setVisibility((current) => ({ ...current, showInApi: false }));
      return;
    }

    setVisibility((current) => ({ ...current, showInApi: value }));
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

  function getMediaCount(type: MediaType) {
    return media.filter((item) => item.type === type).length;
  }

  async function uploadMediaFile(
    file: File,
    type: MediaType,
    productIdForMedia: string,
    sortOrder: number,
    skuForMedia?: string,
  ) {
    const fileLimitError = getFileLimitError(file, type);

    if (fileLimitError) {
      return { error: fileLimitError };
    }

    if (!companyId) {
      return { error: "Компания текущего пользователя не найдена." };
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError) {
      return { error: `Не удалось проверить сессию: ${getErrorMessage(userError)}` };
    }

    if (!userData.user) {
      return { error: "Сессия пользователя не найдена. Войдите заново и повторите загрузку." };
    }

    if (isEdit && !isEditableProduct) {
      return { error: "Товар не найден в текущей компании." };
    }

    const storageFileName = createMediaStorageFileName(file, skuForMedia || form.sku || "product");
    const filePath = `${companyId}/${productIdForMedia}/${storageFileName}`;

    try {
      const { error: uploadError } = await supabase.storage.from(MEDIA_BUCKET).upload(filePath, file, {
        contentType: file.type || undefined,
        upsert: false,
      });

      if (uploadError) {
        logMediaError({ stage: "storage_upload", file, path: filePath, error: uploadError });
        return { error: `Не удалось загрузить файл в Supabase Storage: ${getErrorMessage(uploadError)}` };
      }

      const { data: publicUrlData } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(filePath);
      const originalUrl = publicUrlData.publicUrl;

      const mediaPayload = {
        company_id: companyId,
        product_id: productIdForMedia,
        media_type: type,
        original_url: originalUrl,
        processed_url: originalUrl,
        thumbnail_url: type === "photo" ? originalUrl : null,
        file_name: storageFileName,
        file_size_bytes: file.size,
        status: "ready",
        sort_order: sortOrder,
      };

      const { data, error: insertError } = await supabase
        .from("product_media")
        .insert(mediaPayload)
        .select("*")
        .single();

      if (insertError) {
        logMediaError({ stage: "product_media_insert", file, path: filePath, error: insertError });
        return { error: `Не удалось сохранить запись медиа: ${getErrorMessage(insertError)}` };
      }

      return { media: mapProductMedia(data as ProductMedia) };
    } catch (error) {
      logMediaError({ stage: "storage_upload", file, path: filePath, error });
      return { error: `Не удалось загрузить файл: ${getErrorMessage(error)}` };
    }
  }

  async function uploadPendingMedia(productIdForMedia: string, skuForMedia?: string) {
    const pendingMedia = media.filter((item) => item.source === "pending" && item.file);

    for (let index = 0; index < pendingMedia.length; index += 1) {
      const item = pendingMedia[index];

      if (!item.file) {
        continue;
      }

      setMedia((current) =>
        current.map((mediaItem) =>
          mediaItem.id === item.id ? { ...mediaItem, status: "processing", error: undefined } : mediaItem,
        ),
      );

      const result = await uploadMediaFile(item.file, item.type, productIdForMedia, index, skuForMedia);

      if (result.error) {
        setMedia((current) =>
          current.map((mediaItem) =>
            mediaItem.id === item.id ? { ...mediaItem, status: "failed", error: result.error } : mediaItem,
          ),
        );
        return result.error;
      }

      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previewUrlsRef.current.delete(item.previewUrl);
      }

      if (result.media) {
        setMedia((current) => current.map((mediaItem) => (mediaItem.id === item.id ? result.media : mediaItem)));
      }
    }

    return null;
  }

  async function addFiles(files: FileList | null, type: MediaType) {
    if (!files?.length) {
      return;
    }

    setPageError(null);

    const selectedFiles = Array.from(files);
    const limit = type === "photo" ? MAX_PHOTOS : MAX_VIDEOS;
    const currentCount = getMediaCount(type);

    if (currentCount + selectedFiles.length > limit) {
      setPageError(type === "photo" ? "Можно загрузить не больше 10 фото." : "Можно загрузить не больше 3 видео.");
      return;
    }

    for (const file of selectedFiles) {
      const error = getFileLimitError(file, type);

      if (error) {
        setPageError(error);
        return;
      }
    }

    const nextMedia = selectedFiles.map((file) => {
      const previewUrl = type === "photo" ? URL.createObjectURL(file) : undefined;

      if (previewUrl) {
        previewUrlsRef.current.add(previewUrl);
      }

      return {
        id: `${file.name}-${file.lastModified}-${createId("media")}`,
        name: file.name,
        type,
        size: formatFileSize(file.size),
        status: "uploaded" as const,
        source: "pending" as const,
        file,
        previewUrl,
      };
    });

    setMedia((current) => [...nextMedia, ...current]);

    if (isEdit && productId) {
      for (let index = 0; index < nextMedia.length; index += 1) {
        const item = nextMedia[index];

        setMedia((current) =>
          current.map((mediaItem) =>
            mediaItem.id === item.id ? { ...mediaItem, status: "processing", error: undefined } : mediaItem,
          ),
        );

        const result = await uploadMediaFile(item.file, item.type, productId, currentCount + index, form.sku);

        if (result.error) {
          setPageError(result.error);
          setMedia((current) =>
            current.map((mediaItem) =>
              mediaItem.id === item.id ? { ...mediaItem, status: "failed", error: result.error } : mediaItem,
            ),
          );
          return;
        }

        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
          previewUrlsRef.current.delete(item.previewUrl);
        }

        if (result.media) {
          setMedia((current) => current.map((mediaItem) => (mediaItem.id === item.id ? result.media : mediaItem)));
        }
      }
    }
  }

  async function removeMedia(id: string) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    const itemToRemove = media.find((mediaItem) => mediaItem.id === id);

    if (!itemToRemove) {
      return;
    }

    if (itemToRemove.source === "existing") {
      setPageError(null);

      const { error } = await supabase
        .from("product_media")
        .delete()
        .eq("id", id)
        .eq("company_id", companyId);

      if (error) {
        logAppError("Product form media delete error", error);
        setPageError("Не удалось удалить медиа.");
        return;
      }
    }

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
      setPageError("Выберите категорию для генерации артикула");
      return;
    }

    const nextSku = await buildUniqueSku(form.categoryId);
    if (!nextSku) {
      setPageError("Не удалось сгенерировать уникальный артикул, попробуйте ещё раз");
      return;
    }

    setForm((current) => ({ ...current, sku: nextSku }));
  }

  async function validateSkuUnique(sku: string) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return false;
    }

    const query = supabase
      .from("products")
      .select("id")
      .eq("company_id", companyId)
      .eq("sku", sku.trim().toUpperCase());

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
      company_id: companyId,
      product_id: productIdForValues,
      custom_field_id: field.id,
      value_text: field.field_type === "text" || field.field_type === "select" ? String(value ?? "").trim() : null,
      value_number: field.field_type === "number" ? Number(value) : null,
      value_boolean: field.field_type === "boolean" ? Boolean(value) : null,
      value_date: null,
    };
  }

  async function saveCustomFieldValues(productIdForValues: string) {
    if (!companyId) {
      return "Компания текущего пользователя не найдена.";
    }

    for (const field of customFieldDefinitions) {
      const value = customFieldValues[field.id];
      const isEmpty = isEmptyCustomFieldValue(field, value);

      if (isEmpty) {
        const { error } = await supabase
          .from("product_custom_values")
          .delete()
          .eq("company_id", companyId)
          .eq("product_id", productIdForValues)
          .eq("custom_field_id", field.id);

        if (error) {
          logAppError("Product form custom value delete error", error);
          return "Не удалось очистить значение пользовательского поля.";
        }

        continue;
      }

      const { data: existingValue, error: existingError } = await supabase
        .from("product_custom_values")
        .select("id")
        .eq("company_id", companyId)
        .eq("product_id", productIdForValues)
        .eq("custom_field_id", field.id)
        .maybeSingle();

      if (existingError) {
        logAppError("Product form custom value lookup error", existingError);
        return "Не удалось проверить значение пользовательского поля.";
      }

      const payload = buildCustomValuePayload(field, productIdForValues);
      const saveResult = existingValue
        ? await supabase
            .from("product_custom_values")
            .update(payload)
            .eq("id", existingValue.id)
            .eq("company_id", companyId)
        : await supabase.from("product_custom_values").insert(payload);

      if (saveResult.error) {
        logAppError("Product form custom value save error", saveResult.error);
        return "Не удалось сохранить значения пользовательских полей.";
      }
    }

    return null;
  }

  async function handleSave() {
    setPageError(null);
    setCustomFieldErrors({});

    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    if (!form.name.trim()) {
      setPageError("Название товара не должно быть пустым.");
      return;
    }

    if (!form.categoryId) {
      setPageError("Выберите категорию товара.");
      return;
    }

    if (isEdit && !isEditableProduct) {
      setPageError("Товар не найден в текущей компании.");
      return;
    }

    if (!categories.some((category) => category.id === form.categoryId && category.company_id === companyId)) {
      setPageError("Выбранная категория не найдена в текущей компании.");
      return;
    }

    let skuForSave = form.sku.trim().toUpperCase();

    if (!skuForSave) {
      const generatedSku = await buildUniqueSku(form.categoryId);

      if (!generatedSku) {
        setPageError("Не удалось сгенерировать уникальный артикул, попробуйте ещё раз");
        return;
      }

      skuForSave = generatedSku;
      setForm((current) => ({ ...current, sku: generatedSku }));
    }

    if (!validateCustomFields()) {
      setPageError("Проверьте пользовательские поля.");
      return;
    }

    const isSkuUnique = await validateSkuUnique(skuForSave);

    if (!isSkuUnique) {
      setPageError("SKU уже используется внутри компании.");
      return;
    }

    setIsSaving(true);

    try {
    const nextStatus = form.status;
    const canShowInApi = nextStatus === "active" || nextStatus === "out_of_stock";
    const payload = {
      company_id: companyId,
      category_id: form.categoryId,
      name: form.name.trim(),
      sku: skuForSave,
      price: Number(form.price) || 0,
      stock: Number(form.stock) || 0,
      status: nextStatus,
      description: form.description.trim() || null,
      keywords,
      is_visible_in_api: canShowInApi ? visibility.showInApi : false,
    };

    const productResult =
      isEdit && productId
        ? await supabase
            .from("products")
            .update(payload)
            .eq("id", productId)
            .eq("company_id", companyId)
            .select("id")
            .single()
        : await supabase.from("products").insert(payload).select("id").single();

    if (productResult.error) {
      logAppError("Product form product save error", productResult.error);
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

    const mediaError = await uploadPendingMedia(savedProductId, skuForSave);

    if (mediaError) {
      setPageError(mediaError);
      setIsSaving(false);
      return;
    }

    router.push("/dashboard/products");
    } catch (error) {
      logAppError("Product form save error", error);
      setPageError(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
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
            <CardDescription>Файлы загружаются в Supabase Storage после сохранения товара.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <input
              ref={photoInputRef}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic"
              multiple
              onChange={(event) => {
                void addFiles(event.target.files, "photo");
                event.target.value = "";
              }}
            />
            <input
              ref={videoInputRef}
              className="hidden"
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov"
              multiple
              onChange={(event) => {
                void addFiles(event.target.files, "video");
                event.target.value = "";
              }}
            />

            <div className="rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-6 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
                <UploadCloud className="size-6" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Перетащите фото или видео сюда</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Фото до 20 MB, видео до 300 MB. До 10 фото и до 3 видео на товар.
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
                          onClick={() => void removeMedia(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      <Badge className={cn("mt-2 gap-1", statusView[item.status].className)}>
                        <StatusIcon className={cn("size-3", item.status === "processing" && "animate-spin")} />
                        {statusView[item.status].label}
                      </Badge>
                      {item.error ? <p className="mt-2 text-xs text-red-600">{item.error}</p> : null}
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
                disabled={isLoading || categories.length === 0}
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
                disabled={isLoading}
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
                          disabled={isLoading}
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
                        <label className="flex h-10 cursor-pointer items-center justify-between gap-3 rounded-md border bg-white px-3 text-sm">
                          <span>Да</span>
                          <Switch
                            id={inputId}
                            checked={Boolean(value)}
                            onCheckedChange={(checked) => updateCustomField(field.id, checked)}
                          />
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
              description={
                form.status === "hidden" || form.status === "draft"
                  ? "Доступно только для активных товаров и товаров без остатка."
                  : "Товар доступен внешнему AI-боту через read-only API."
              }
              checked={visibility.showInApi && form.status !== "hidden" && form.status !== "draft"}
              disabled={form.status === "hidden" || form.status === "draft"}
              onChange={(checked) => updateVisibility("showInApi", checked)}
            />
            <ToggleRow
              title="Скрыть товар"
              description="Скрытый товар не доступен в каталоге и API."
              checked={form.status === "hidden"}
              onChange={(checked) => updateVisibility("hidden", checked)}
            />
            <ToggleRow
              title="Черновик"
              description="Черновик не доступен в API до публикации."
              checked={form.status === "draft"}
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
