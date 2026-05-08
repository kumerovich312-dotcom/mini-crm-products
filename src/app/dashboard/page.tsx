import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  KeyRound,
  Layers3,
  PackageMinus,
  PackageX,
  PlusCircle,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const kpis = [
  {
    label: "Всего товаров",
    value: "128",
    description: "В каталоге компании",
    icon: Boxes,
  },
  {
    label: "В наличии",
    value: "94",
    description: "Готовы к выдаче в API",
    icon: CheckCircle2,
  },
  {
    label: "Мало в наличии",
    value: "17",
    description: "Остаток 1-3 шт.",
    icon: PackageMinus,
  },
  {
    label: "Нет в наличии",
    value: "17",
    description: "Нужна проверка остатков",
    icon: PackageX,
  },
  {
    label: "Последнее обновление",
    value: "Сегодня, 12:40",
    description: "Импорт и ручные правки",
    icon: Clock3,
  },
];

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

const recentImports = [
  {
    fileName: "catalog_may_08.csv",
    date: "08.05.2026",
    status: "Готово",
    products: 42,
    errors: 0,
  },
  {
    fileName: "new_arrivals.xlsx",
    date: "07.05.2026",
    status: "С ошибками",
    products: 18,
    errors: 3,
  },
  {
    fileName: "stock_update.csv",
    date: "06.05.2026",
    status: "Готово",
    products: 128,
    errors: 0,
  },
];

const latestProducts = [
  {
    sku: "JWL-001-A7K9",
    name: "Серьги Aurora",
    category: "Серьги",
    price: "24 900 ₸",
    stock: 8,
    status: "В API",
    imageClass: "bg-blue-100 text-blue-700",
  },
  {
    sku: "JWL-002-P2M4",
    name: "Кольцо Classic",
    category: "Кольца",
    price: "31 500 ₸",
    stock: 3,
    status: "В API",
    imageClass: "bg-sky-100 text-sky-700",
  },
  {
    sku: "JWL-003-K8D1",
    name: "Подвеска Moonlight",
    category: "Подвески",
    price: "19 000 ₸",
    stock: 0,
    status: "Черновик",
    imageClass: "bg-slate-100 text-slate-600",
  },
  {
    sku: "JWL-004-M7Q2",
    name: "Браслет Line",
    category: "Браслеты",
    price: "27 400 ₸",
    stock: 12,
    status: "В API",
    imageClass: "bg-indigo-100 text-indigo-700",
  },
];

function statusClass(status: string) {
  if (status === "Готово" || status === "В API") {
    return "bg-emerald-50 text-emerald-700";
  }

  if (status === "С ошибками") {
    return "bg-amber-50 text-amber-700";
  }

  return "bg-slate-100 text-slate-700";
}

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        badge="Дашборд"
        title="Мини-CRM товаров"
        description="Общая картина по товарам, остаткам и последним обновлениям."
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;

          return (
            <Card key={kpi.label}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-muted-foreground">{kpi.label}</p>
                    <p className="mt-2 text-2xl font-semibold tracking-normal">{kpi.value}</p>
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
                  {recentImports.map((item) => (
                    <tr key={item.fileName} className="border-t">
                      <td className="px-4 py-3 font-medium">{item.fileName}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.date}</td>
                      <td className="px-4 py-3">
                        <Badge className={statusClass(item.status)}>{item.status}</Badge>
                      </td>
                      <td className="px-4 py-3">{item.products}</td>
                      <td className="px-4 py-3">
                        <span className={cn(item.errors > 0 && "inline-flex items-center gap-1 text-amber-700")}>
                          {item.errors > 0 ? <AlertTriangle className="size-4" /> : null}
                          {item.errors}
                        </span>
                      </td>
                    </tr>
                  ))}
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
                  <th className="px-4 py-3 font-medium">Фото</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Название</th>
                  <th className="px-4 py-3 font-medium">Категория</th>
                  <th className="px-4 py-3 font-medium">Цена</th>
                  <th className="px-4 py-3 font-medium">Остаток</th>
                  <th className="px-4 py-3 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {latestProducts.map((product) => (
                  <tr key={product.sku} className="border-t">
                    <td className="px-4 py-3">
                      <div
                        className={cn(
                          "flex size-11 items-center justify-center rounded-md text-xs font-semibold",
                          product.imageClass,
                        )}
                      >
                        IMG
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{product.sku}</td>
                    <td className="px-4 py-3 font-medium">{product.name}</td>
                    <td className="px-4 py-3">{product.category}</td>
                    <td className="px-4 py-3">{product.price}</td>
                    <td className="px-4 py-3">{product.stock}</td>
                    <td className="px-4 py-3">
                      <Badge className={statusClass(product.status)}>{product.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
