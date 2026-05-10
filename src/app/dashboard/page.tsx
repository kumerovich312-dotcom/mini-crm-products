"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  KeyRound,
  Layers3,
  Loader2,
  PackageMinus,
  PackageX,
  PlusCircle,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Category, Product } from "@/types/database";

type ImportRow = {
  id: string;
  file_name: string;
  status: string;
  success_rows: number;
  error_rows: number;
  created_at: string;
};

const quickActions = [
  {
    title: "Добавить товар",
    description: "Создать карточку товара вручную",
    href: "/dashboard/products/new",
    icon: PlusCircle,
  },
  {
    title: "Импорт товаров",
    description: "Загрузить Excel или CSV",
    href: "/dashboard/import",
    icon: FileSpreadsheet,
  },
  {
    title: "Категории",
    description: "Настроить категории и коды",
    href: "/dashboard/categories",
    icon: Layers3,
  },
  {
    title: "API для ИИ",
    description: "Проверить read-only доступ",
    href: "/dashboard/api",
    icon: KeyRound,
  },
];

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
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "completed" || status === "active") {
    return "bg-emerald-50 text-emerald-700";
  }

  if (status === "failed" || status === "validating") {
    return "bg-amber-50 text-amber-700";
  }

  if (status === "out_of_stock") {
    return "bg-red-50 text-red-700";
  }

  return "bg-slate-100 text-slate-700";
}

function importStatusLabel(status: string) {
  if (status === "completed") {
    return "Готово";
  }

  if (status === "failed") {
    return "С ошибками";
  }

  if (status === "validating") {
    return "Проверка";
  }

  return status;
}

function productStatusLabel(status: Product["status"]) {
  if (status === "active") {
    return "Активен";
  }

  if (status === "hidden") {
    return "Скрыт";
  }

  if (status === "draft") {
    return "Черновик";
  }

  return "Нет в наличии";
}

export default function DashboardPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    let currentCompanyId: string | null = null;

    try {
      currentCompanyId = await getCurrentCompanyId();
    } catch (error) {
      logAppError("Dashboard profile error", error);
      setPageError(getErrorMessage(error));
      setProducts([]);
      setCategories([]);
      setImports([]);
      setIsLoading(false);
      return;
    }

    if (!currentCompanyId) {
      setPageError("Компания текущего пользователя не найдена. Войдите заново.");
      setProducts([]);
      setCategories([]);
      setImports([]);
      setIsLoading(false);
      return;
    }

    const [productsResult, categoriesResult, importsResult] = await Promise.all([
      supabase
        .from("products")
        .select("*")
        .eq("company_id", currentCompanyId)
        .order("updated_at", { ascending: false })
        .limit(5),
      supabase
        .from("categories")
        .select("*")
        .eq("company_id", currentCompanyId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("imports")
        .select("id, file_name, status, success_rows, error_rows, created_at")
        .eq("company_id", currentCompanyId)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    const error = productsResult.error ?? categoriesResult.error ?? importsResult.error;

    if (error) {
      logAppError("Dashboard data error", error);
      setPageError(error.message);
    }

    setProducts(((productsResult.data ?? []) as Product[]) ?? []);
    setCategories(((categoriesResult.data ?? []) as Category[]) ?? []);
    setImports(((importsResult.data ?? []) as ImportRow[]) ?? []);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const categoryMap = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const kpis = useMemo(
    () => [
      {
        label: "Всего товаров",
        value: String(products.length),
        description: "В каталоге компании",
        icon: Boxes,
      },
      {
        label: "В наличии",
        value: String(products.filter((product) => product.stock > 0).length),
        description: "Товары с остатком больше 0",
        icon: CheckCircle2,
      },
      {
        label: "Мало в наличии",
        value: String(products.filter((product) => product.stock > 0 && product.stock <= 3).length),
        description: "Остаток 1-3 шт.",
        icon: PackageMinus,
      },
      {
        label: "Нет в наличии",
        value: String(products.filter((product) => product.stock === 0).length),
        description: "Нужно проверить остатки",
        icon: PackageX,
      },
      {
        label: "Последнее обновление",
        value: products[0] ? formatDate(products[0].updated_at) : "Пока нет",
        description: "Последнее изменение товара",
        icon: Clock3,
      },
    ],
    [products],
  );

  return (
    <>
      <PageHeader
        badge="Дашборд"
        title="Мини-CRM товаров"
        description="Общая картина по товарам, остаткам и последним обновлениям."
      />

      {pageError ? (
        <Card className="mb-6 border-red-100 bg-red-50">
          <CardContent className="p-5 text-sm text-red-700">{pageError}</CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;

          return (
            <Card key={kpi.label}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-muted-foreground">{kpi.label}</p>
                    <p className="mt-2 text-2xl font-semibold tracking-normal">{isLoading ? "..." : kpi.value}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{kpi.description}</p>
                  </div>
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Icon className="size-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Быстрые действия</CardTitle>
            <CardDescription>Основные действия для ведения товарного каталога.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {quickActions.map((action) => {
              const Icon = action.icon;

              return (
                <Link
                  key={action.href}
                  href={action.href}
                  className="group rounded-lg border bg-white p-4 transition-colors hover:border-primary/40 hover:bg-blue-50/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <Icon className="size-5" />
                    </div>
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold">{action.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{action.description}</p>
                </Link>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>Недавние импорты</CardTitle>
              <CardDescription>Последние загрузки Excel/CSV и результат обработки.</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/import">Открыть импорт</Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Файл</th>
                    <th className="px-4 py-3 font-medium">Дата</th>
                    <th className="px-4 py-3 font-medium">Статус</th>
                    <th className="px-4 py-3 font-medium">Товары</th>
                    <th className="px-4 py-3 font-medium">Ошибки</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="size-4 animate-spin" />
                          Загрузка
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading && imports.length === 0 ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                        Импортов пока нет
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading
                    ? imports.map((item) => (
                        <tr key={item.id} className="border-t">
                          <td className="px-4 py-3 font-medium">{item.file_name}</td>
                          <td className="px-4 py-3 text-muted-foreground">{formatDate(item.created_at)}</td>
                          <td className="px-4 py-3">
                            <Badge className={statusClass(item.status)}>{importStatusLabel(item.status)}</Badge>
                          </td>
                          <td className="px-4 py-3">{item.success_rows}</td>
                          <td className="px-4 py-3">
                            <span className={cn(item.error_rows > 0 && "inline-flex items-center gap-1 text-amber-700")}>
                              {item.error_rows > 0 ? <AlertTriangle className="size-4" /> : null}
                              {item.error_rows}
                            </span>
                          </td>
                        </tr>
                      ))
                    : null}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card className="mt-6">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Последние товары</CardTitle>
            <CardDescription>Свежие карточки товара с ценой, остатком и статусом видимости.</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/products">Все товары</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full border-collapse bg-white text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Название</th>
                  <th className="px-4 py-3 font-medium">Категория</th>
                  <th className="px-4 py-3 font-medium">Цена</th>
                  <th className="px-4 py-3 font-medium">Остаток</th>
                  <th className="px-4 py-3 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        Загрузка товаров
                      </span>
                    </td>
                  </tr>
                ) : null}
                {!isLoading && products.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                      Товары пока не добавлены
                    </td>
                  </tr>
                ) : null}
                {!isLoading
                  ? products.map((product) => (
                      <tr key={product.id} className="border-t">
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{product.sku}</td>
                        <td className="px-4 py-3 font-medium">{product.name}</td>
                        <td className="px-4 py-3">
                          {product.category_id ? categoryMap.get(product.category_id) ?? "Без категории" : "Без категории"}
                        </td>
                        <td className="px-4 py-3">{formatPrice(product.price)} KGS</td>
                        <td className="px-4 py-3">{product.stock}</td>
                        <td className="px-4 py-3">
                          <Badge className={statusClass(product.status)}>{productStatusLabel(product.status)}</Badge>
                        </td>
                      </tr>
                    ))
                  : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
