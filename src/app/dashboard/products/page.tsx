"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  Edit3,
  Eye,
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
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Category, Product, ProductMedia, ProductStatus } from "@/types/database";

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

const filterSelectClass =
  "h-10 rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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

export default function ProductsPage() {
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [mediaByProductId, setMediaByProductId] = useState<Map<string, ProductMedia[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  const [stockFilter, setStockFilter] = useState("");

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);
    const currentCompanyId = await getCurrentCompanyId();

    if (!currentCompanyId) {
      setPageError("Компания текущего пользователя не найдена. Войдите заново.");
      setProducts([]);
      setCategories([]);
      setMediaByProductId(new Map());
      setIsLoading(false);
      return;
    }

    setCompanyId(currentCompanyId);

    const [productsResult, categoriesResult] = await Promise.all([
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
    ]);

    if (productsResult.error) {
      setPageError(productsResult.error.message);
    }

    if (categoriesResult.error) {
      setPageError(categoriesResult.error.message);
    }

    const nextProducts = ((productsResult.data ?? []) as Product[]) ?? [];
    setProducts(nextProducts);
    setCategories(((categoriesResult.data ?? []) as Category[]) ?? []);

    if (nextProducts.length > 0) {
      const { data: mediaData, error: mediaError } = await supabase
        .from("product_media")
        .select("*")
        .eq("company_id", currentCompanyId)
        .in(
          "product_id",
          nextProducts.map((product) => product.id),
        )
        .order("sort_order", { ascending: true });

      if (mediaError) {
        setPageError(mediaError.message);
      }

      const nextMediaByProductId = new Map<string, ProductMedia[]>();

      ((mediaData ?? []) as ProductMedia[]).forEach((mediaItem) => {
        const productMedia = nextMediaByProductId.get(mediaItem.product_id) ?? [];
        productMedia.push(mediaItem);
        nextMediaByProductId.set(mediaItem.product_id, productMedia);
      });

      setMediaByProductId(nextMediaByProductId);
    } else {
      setMediaByProductId(new Map());
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

  async function hideProduct(product: Product) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    setPageError(null);

    const { error } = await supabase
      .from("products")
      .update({ status: "hidden", is_visible_in_api: false })
      .eq("id", product.id)
      .eq("company_id", companyId);

    if (error) {
      setPageError(error.message);
      return;
    }

    await loadData();
  }

  async function deleteProduct(product: Product) {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    setPageError(null);

    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", product.id)
      .eq("company_id", companyId);

    if (error) {
      setPageError(error.message);
      return;
    }

    await loadData();
  }

  function resetFilters() {
    setQuery("");
    setCategoryId("");
    setStatus("");
    setStockFilter("");
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
            <Button variant="outline" disabled>
              <Download />
              Экспорт
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
            <select className={filterSelectClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Все статусы</option>
              <option value="active">Активен</option>
              <option value="hidden">Скрыт</option>
              <option value="out_of_stock">Нет в наличии</option>
              <option value="draft">Черновик</option>
            </select>
            <select
              className={filterSelectClass}
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
              <table className="w-full min-w-[1120px] border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Фото</th>
                    <th className="px-4 py-3 font-medium">Видео</th>
                    <th className="px-4 py-3 font-medium">SKU</th>
                    <th className="px-4 py-3 font-medium">Название</th>
                    <th className="px-4 py-3 font-medium">Категория</th>
                    <th className="px-4 py-3 font-medium">Цена</th>
                    <th className="px-4 py-3 font-medium">Остаток</th>
                    <th className="px-4 py-3 font-medium">Статус</th>
                    <th className="px-4 py-3 font-medium">Обновлено</th>
                    <th className="px-4 py-3 text-right font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td className="px-4 py-10 text-center text-muted-foreground" colSpan={10}>
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="size-4 animate-spin" />
                          Загрузка товаров
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading && filteredProducts.length === 0 ? (
                    <tr>
                      <td className="px-4 py-10" colSpan={10}>
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
                        const firstPhoto = productMedia.find((item) => (item.media_type ?? item.type) === "photo");
                        const firstPhotoUrl =
                          firstPhoto?.thumbnail_url ??
                          firstPhoto?.processed_url ??
                          firstPhoto?.optimized_url ??
                          firstPhoto?.original_url;
                        const hasVideo = productMedia.some((item) => (item.media_type ?? item.type) === "video");

                        return (
                          <tr key={product.id} className="border-t align-middle hover:bg-slate-50/70">
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
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{product.sku}</td>
                            <td className="px-4 py-3">
                              <div>
                                <p className="font-medium">{product.name}</p>
                                <p className="mt-1 max-w-56 truncate text-xs text-muted-foreground">
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
                            <td className="px-4 py-3 text-muted-foreground">{formatDate(product.updated_at)}</td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-1">
                                <Button asChild variant="ghost" size="icon" aria-label="Открыть">
                                  <Link href={`/dashboard/products/${product.id}/edit`}>
                                    <Eye />
                                  </Link>
                                </Button>
                                <Button asChild variant="ghost" size="icon" aria-label="Редактировать">
                                  <Link href={`/dashboard/products/${product.id}/edit`}>
                                    <Edit3 />
                                  </Link>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Скрыть"
                                  onClick={() => void hideProduct(product)}
                                >
                                  <EyeOff />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Удалить"
                                  onClick={() => void deleteProduct(product)}
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
    </>
  );
}
