"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  Bot,
  Download,
  Edit3,
  EyeOff,
  FileSpreadsheet,
  ImageIcon,
  Loader2,
  PackageOpen,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  VideoOff,
} from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { selectClassName } from "@/components/ui/select-style";
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Category, CustomField, Product, ProductCustomValue, ProductMedia, ProductStatus } from "@/types/database";

const statusMap: Record<ProductStatus, { label: string; className: string }> = {
  active: {
    label: "Активен",
    className: "bg-emerald-50 text-emerald-700",
  },
  hidden: {
    label: "Скрыт",
    className: "bg-slate-100 text-slate-700",
  },
  out_of_stock: {
    label: "Нет в наличии",
    className: "bg-red-50 text-red-700",
  },
  draft: {
    label: "Черновик",
    className: "bg-orange-50 text-orange-700",
  },
};

const filterSelectClass = selectClassName;

type ExportFormat = "csv" | "xlsx";

function formatPrice(price: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(price);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getExportDate() {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getCustomFieldValue(field: CustomField, value: ProductCustomValue) {
  if (field.field_type === "number") {
    return value.value_number ?? "";
  }

  if (field.field_type === "boolean") {
    return value.value_boolean === null ? "" : value.value_boolean ? "Да" : "Нет";
  }

  return value.value_text ?? "";
}

function getApiBadge(product: Product) {
  if (product.stock <= 0) {
    return { label: "Нет остатка", className: "bg-slate-100 text-slate-700" };
  }

  if (product.status === "active" && product.is_visible_in_api) {
    return { label: "Бот", className: "bg-emerald-50 text-emerald-700" };
  }

  return { label: "—", className: "bg-slate-100 text-slate-600" };
}

function getRowClassName(product: Product) {
  if (product.status === "hidden") {
    return "bg-slate-50/80 text-muted-foreground opacity-75 hover:bg-slate-100/80";
  }

  if (product.status === "draft") {
    return "border-l-2 border-l-amber-200 bg-amber-50/20 hover:bg-amber-50/40";
  }

  if (product.stock <= 0) {
    return "border-l-2 border-l-orange-200 bg-orange-50/20 hover:bg-orange-50/40";
  }

  if (product.status === "active" && product.is_visible_in_api) {
    return "border-l-2 border-l-emerald-200 hover:bg-emerald-50/20";
  }

  return "hover:bg-slate-50/70";
}

export default function ProductsPage() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<ProductCustomValue[]>([]);
  const [mediaByProductId, setMediaByProductId] = useState<Map<string, ProductMedia[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  const [stockFilter, setStockFilter] = useState("");
  const [productPendingDelete, setProductPendingDelete] = useState<Product | null>(null);
  const [isDeletingProduct, setIsDeletingProduct] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);
    let currentCompanyId: string | null = null;

    try {
      currentCompanyId = await getCurrentCompanyId();
    } catch (error) {
      logAppError("Products profile error", error);
      setPageError(getErrorMessage(error));
      setProducts([]);
      setCategories([]);
      setCustomFields([]);
      setCustomValues([]);
      setMediaByProductId(new Map());
      setIsLoading(false);
      return;
    }

    if (!currentCompanyId) {
      setPageError("Компания текущего пользователя не найдена. Войдите заново.");
      setProducts([]);
      setCategories([]);
      setCustomFields([]);
      setCustomValues([]);
      setMediaByProductId(new Map());
      setIsLoading(false);
      return;
    }

    setCompanyId(currentCompanyId);

    const [productsResult, categoriesResult, customFieldsResult] = await Promise.all([
      supabase
        .from("products")
        .select("*")
        .eq("company_id", currentCompanyId)
        .order("updated_at", { ascending: false }),
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

    if (productsResult.error) {
      setPageError(productsResult.error.message);
    }

    if (categoriesResult.error) {
      setPageError(categoriesResult.error.message);
    }

    if (customFieldsResult.error) {
      setPageError(customFieldsResult.error.message);
    }

    const nextProducts = ((productsResult.data ?? []) as Product[]) ?? [];
    setProducts(nextProducts);
    setCategories(((categoriesResult.data ?? []) as Category[]) ?? []);
    setCustomFields(((customFieldsResult.data ?? []) as CustomField[]) ?? []);

    if (nextProducts.length > 0) {
      const [mediaResult, customValuesResult] = await Promise.all([
        supabase
          .from("product_media")
          .select("*")
          .eq("company_id", currentCompanyId)
          .in(
            "product_id",
            nextProducts.map((product) => product.id),
          )
          .order("sort_order", { ascending: true }),
        supabase
          .from("product_custom_values")
          .select("*")
          .eq("company_id", currentCompanyId)
          .in(
            "product_id",
            nextProducts.map((product) => product.id),
          ),
      ]);

      if (mediaResult.error) {
        setPageError(mediaResult.error.message);
      }

      if (customValuesResult.error) {
        setPageError(customValuesResult.error.message);
      }

      const nextMediaByProductId = new Map<string, ProductMedia[]>();

      ((mediaResult.data ?? []) as ProductMedia[]).forEach((mediaItem) => {
        const productMedia = nextMediaByProductId.get(mediaItem.product_id) ?? [];
        productMedia.push(mediaItem);
        nextMediaByProductId.set(mediaItem.product_id, productMedia);
      });

      setMediaByProductId(nextMediaByProductId);
      setCustomValues(((customValuesResult.data ?? []) as ProductCustomValue[]) ?? []);
    } else {
      setMediaByProductId(new Map());
      setCustomValues([]);
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const categoryMap = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const customValuesByProductId = useMemo(() => {
    const nextValues = new Map<string, ProductCustomValue[]>();

    customValues.forEach((value) => {
      const productValues = nextValues.get(value.product_id) ?? [];
      productValues.push(value);
      nextValues.set(value.product_id, productValues);
    });

    return nextValues;
  }, [customValues]);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return products.filter((product) => {
      const matchesQuery =
        !normalizedQuery ||
        product.name.toLowerCase().includes(normalizedQuery) ||
        product.sku.toLowerCase().includes(normalizedQuery) ||
        product.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery));

      const matchesCategory = !categoryId || product.category_id === categoryId;
      const matchesStatus = !status || product.status === status;
      const matchesStock =
        !stockFilter ||
        (stockFilter === "in_stock" && product.stock > 3) ||
        (stockFilter === "low_stock" && product.stock > 0 && product.stock <= 3) ||
        (stockFilter === "out_of_stock" && product.stock === 0);

      return matchesQuery && matchesCategory && matchesStatus && matchesStock;
    });
  }, [categoryId, products, query, status, stockFilter]);

  async function toggleProductVisibility(product: Product) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    if (product.status !== "active" && product.status !== "hidden") {
      setPageError("Черновик или товар без наличия нельзя случайно перевести в активный статус через скрытие.");
      return;
    }

    setPageError(null);
    const nextValues =
      product.status === "hidden"
        ? { status: "active" as ProductStatus }
        : { status: "hidden" as ProductStatus, is_visible_in_api: false };

    const { error } = await supabase
      .from("products")
      .update(nextValues)
      .eq("id", product.id)
      .eq("company_id", companyId);

    if (error) {
      setPageError(error.message);
      return;
    }

    setProducts((current) =>
      current.map((item) => (item.id === product.id ? { ...item, ...nextValues, updated_at: new Date().toISOString() } : item)),
    );
  }

  async function toggleProductApiVisibility(product: Product) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    if (product.status === "hidden" || product.status === "draft") {
      setPageError("Сначала активируйте товар");
      return;
    }

    setPageError(null);
    const nextIsVisibleInApi = !product.is_visible_in_api;
    const { error } = await supabase
      .from("products")
      .update({ is_visible_in_api: nextIsVisibleInApi })
      .eq("id", product.id)
      .eq("company_id", companyId);

    if (error) {
      setPageError(error.message);
      return;
    }

    setProducts((current) =>
      current.map((item) =>
        item.id === product.id
          ? { ...item, is_visible_in_api: nextIsVisibleInApi, updated_at: new Date().toISOString() }
          : item,
      ),
    );
  }

  async function deleteProduct(product: Product) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    setIsDeletingProduct(true);
    setPageError(null);

    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", product.id)
      .eq("company_id", companyId);

    if (error) {
      setPageError(error.message);
      setIsDeletingProduct(false);
      return;
    }

    setProducts((current) => current.filter((item) => item.id !== product.id));
    setMediaByProductId((current) => {
      const nextMedia = new Map(current);
      nextMedia.delete(product.id);
      return nextMedia;
    });
    setCustomValues((current) => current.filter((value) => value.product_id !== product.id));
    setProductPendingDelete(null);
    setIsDeletingProduct(false);
  }

  function resetFilters() {
    setQuery("");
    setCategoryId("");
    setStatus("");
    setStockFilter("");
  }

  function buildExportRows() {
    return filteredProducts.map((product) => {
      const productMedia = mediaByProductId.get(product.id) ?? [];
      const firstPhoto = productMedia.find((item) => item.media_type === "photo");
      const productCustomValues = customValuesByProductId.get(product.id) ?? [];
      const customValuesByFieldId = new Map(productCustomValues.map((value) => [value.custom_field_id, value]));
      const row: Record<string, string | number | boolean> = {
        SKU: product.sku,
        Название: product.name,
        Категория: product.category_id ? categoryMap.get(product.category_id) ?? "" : "",
        Цена: product.price,
        Остаток: product.stock,
        Статус: statusMap[product.status].label,
        Описание: product.description ?? "",
        Keywords: product.keywords.join(", "),
        "Показывать в API": product.is_visible_in_api ? "Да" : "Нет",
        "Дата создания": formatDate(product.created_at),
        "Дата обновления": formatDate(product.updated_at),
      };

      customFields.forEach((field) => {
        const value = customValuesByFieldId.get(field.id);
        row[field.name || field.key] = value ? getCustomFieldValue(field, value) : "";
      });

      row.main_image_url = firstPhoto?.processed_url ?? firstPhoto?.original_url ?? "";
      row.media_count = productMedia.length;

      return row;
    });
  }

  function exportProducts(format: ExportFormat) {
    setPageError(null);

    if (filteredProducts.length === 0) {
      setPageError("Нет товаров для экспорта");
      return;
    }

    const rows = buildExportRows();
    const fileDate = getExportDate();

    if (format === "csv") {
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
      downloadBlob(blob, `products-export-${fileDate}.csv`);
      return;
    }

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Products");
    XLSX.writeFile(workbook, `products-export-${fileDate}.xlsx`);
  }

  return (
    <>
      <PageHeader
        badge="Каталог"
        title="Товары"
        description="Управление каталогом, ценами, остатками, фото и видео товаров."
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/dashboard/products/new">
                <Plus />
                Добавить товар
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/import">
                <FileSpreadsheet />
                Импорт
              </Link>
            </Button>
            <Button variant="outline" onClick={() => exportProducts("csv")}>
              <Download />
              Экспорт CSV
            </Button>
            <Button variant="outline" onClick={() => exportProducts("xlsx")}>
              <Download />
              Экспорт Excel
            </Button>
          </div>
        }
      />

      {pageError ? (
        <Card className="mb-6 border-red-100 bg-red-50">
          <CardContent className="p-5 text-sm text-red-700">{pageError}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Рабочая таблица каталога</CardTitle>
              <CardDescription>Найдено товаров: {filteredProducts.length}</CardDescription>
            </div>
            <Badge className="w-fit bg-blue-50 text-blue-700">Supabase</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Поиск по названию, SKU и ключевым словам"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select
              className={filterSelectClass}
              disabled={isLoading}
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Все категории</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <select
              className={filterSelectClass}
              disabled={isLoading}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">Все статусы</option>
              <option value="active">Активен</option>
              <option value="hidden">Скрыт</option>
              <option value="out_of_stock">Нет в наличии</option>
              <option value="draft">Черновик</option>
            </select>
            <select
              className={filterSelectClass}
              disabled={isLoading}
              value={stockFilter}
              onChange={(event) => setStockFilter(event.target.value)}
            >
              <option value="">Любое наличие</option>
              <option value="in_stock">В наличии</option>
              <option value="low_stock">Мало в наличии</option>
              <option value="out_of_stock">Нет в наличии</option>
            </select>
            <Button variant="outline" onClick={resetFilters}>
              <RotateCcw />
              Сбросить
            </Button>
          </div>

          <div className="mt-5 overflow-hidden rounded-lg border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1060px] table-fixed border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="w-20 px-4 py-3 font-medium">Фото</th>
                    <th className="w-20 px-4 py-3 font-medium">Видео</th>
                    <th className="w-36 px-4 py-3 font-medium">SKU</th>
                    <th className="w-[280px] px-4 py-3 font-medium">Название</th>
                    <th className="w-40 px-4 py-3 font-medium">Категория</th>
                    <th className="w-24 px-4 py-3 font-medium">Цена</th>
                    <th className="w-24 px-4 py-3 font-medium">Остаток</th>
                    <th className="w-28 px-4 py-3 font-medium">Статус</th>
                    <th className="w-28 px-4 py-3 font-medium">Бот/API</th>
                    <th className="w-36 px-4 py-3 font-medium">Обновлено</th>
                    <th className="w-40 px-4 py-3 text-right font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td className="px-4 py-10 text-center text-muted-foreground" colSpan={11}>
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="size-4 animate-spin" />
                          Загрузка товаров
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading && filteredProducts.length === 0 ? (
                    <tr>
                      <td className="px-4 py-10" colSpan={11}>
                        <EmptyState
                          icon={PackageOpen}
                          title={products.length === 0 ? "Товары пока не добавлены" : "Товары не найдены"}
                          description="Измените поиск или фильтры, либо добавьте первый товар."
                        />
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading
                    ? filteredProducts.map((product) => {
                        const statusView = statusMap[product.status];
                        const productMedia = mediaByProductId.get(product.id) ?? [];
                        const firstPhoto = productMedia.find((item) => item.media_type === "photo");
                        const firstPhotoUrl =
                          firstPhoto?.thumbnail_url ??
                          firstPhoto?.processed_url ??
                          firstPhoto?.original_url;
                        const hasVideo = productMedia.some((item) => item.media_type === "video");
                        const apiBadge = getApiBadge(product);
                        const apiToggleDisabled = product.status === "hidden" || product.status === "draft";

                        return (
                          <tr
                            key={product.id}
                            className={cn("cursor-pointer border-t align-middle transition-colors", getRowClassName(product))}
                            onClick={() => router.push(`/dashboard/products/${product.id}/edit`)}
                          >
                            <td className="px-4 py-3">
                              <div className="flex size-12 items-center justify-center overflow-hidden rounded-md bg-blue-50 text-blue-700">
                                {firstPhotoUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img alt={product.name} className="size-full object-cover" src={firstPhotoUrl} />
                                ) : (
                                  <ImageIcon className="size-5" />
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div
                                className={cn(
                                  "flex size-9 items-center justify-center rounded-md",
                                  hasVideo ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-muted-foreground",
                                )}
                              >
                                {hasVideo ? <Play className="size-4" /> : <VideoOff className="size-4" />}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className="block max-w-28 truncate font-mono text-xs text-muted-foreground"
                                title={product.sku}
                              >
                                {product.sku}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="max-w-[260px]">
                                <p className="truncate whitespace-nowrap font-medium" title={product.name}>
                                  {product.name}
                                </p>
                                <p className="mt-1 truncate whitespace-nowrap text-xs text-muted-foreground">
                                  {product.keywords.join(", ")}
                                </p>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              {product.category_id ? categoryMap.get(product.category_id) ?? "Без категории" : "Без категории"}
                            </td>
                            <td className="px-4 py-3 font-medium">{formatPrice(product.price)}</td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  "font-medium",
                                  product.stock === 0 && "text-red-700",
                                  product.stock > 0 && product.stock <= 3 && "text-amber-700",
                                )}
                              >
                                {product.stock}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <Badge className={statusView.className}>{statusView.label}</Badge>
                            </td>
                            <td className="px-4 py-3">
                              <Badge className={apiBadge.className}>{apiBadge.label}</Badge>
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">{formatDate(product.updated_at)}</td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-1">
                                <Button asChild variant="ghost" size="icon" aria-label="Редактировать" title="Редактировать">
                                  <Link
                                    href={`/dashboard/products/${product.id}/edit`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <Edit3 />
                                  </Link>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Переключить видимость в API"
                                  title={apiToggleDisabled ? "Сначала активируйте товар" : "Переключить видимость в API"}
                                  disabled={apiToggleDisabled}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void toggleProductApiVisibility(product);
                                  }}
                                >
                                  <Bot className={product.is_visible_in_api ? "text-emerald-700" : undefined} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={product.status === "hidden" ? "Показать товар" : "Скрыть товар"}
                                  title={product.status === "hidden" ? "Показать товар" : "Скрыть товар"}
                                  disabled={product.status !== "active" && product.status !== "hidden"}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void toggleProductVisibility(product);
                                  }}
                                >
                                  <EyeOff />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Удалить"
                                  title="Удалить"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setProductPendingDelete(product);
                                  }}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-muted-foreground">
              Показано {filteredProducts.length} из {products.length} товаров
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled>
                Назад
              </Button>
              <Button size="sm">1</Button>
              <Button variant="outline" size="sm" disabled>
                Вперед
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {productPendingDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-product-title"
        >
          <div className="w-full max-w-sm rounded-lg border bg-white p-5 shadow-soft">
            <h2 id="delete-product-title" className="text-lg font-semibold">
              Удалить товар?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">Это действие нельзя отменить.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isDeletingProduct}
                onClick={() => setProductPendingDelete(null)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                className="bg-red-600 text-white hover:bg-red-700"
                disabled={isDeletingProduct}
                onClick={() => void deleteProduct(productPendingDelete)}
              >
                {isDeletingProduct ? <Loader2 className="animate-spin" /> : null}
                Удалить
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
