import Link from "next/link";
import {
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileSpreadsheet,
  ImageIcon,
  MoreHorizontal,
  PackageOpen,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Video,
  VideoOff,
} from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ProductStatus = "active" | "hidden" | "out_of_stock" | "draft";

const products: Array<{
  sku: string;
  name: string;
  category: string;
  price: string;
  stock: number;
  status: ProductStatus;
  updatedAt: string;
  hasVideo: boolean;
  keywords: string[];
  thumbnailClass: string;
}> = [
  {
    sku: "JWL-001-A7K9",
    name: "Серьги Aurora",
    category: "Ювелирка",
    price: "24 900 ₸",
    stock: 8,
    status: "active",
    updatedAt: "Сегодня, 12:40",
    hasVideo: true,
    keywords: ["серьги", "золото", "aurora"],
    thumbnailClass: "bg-blue-100 text-blue-700",
  },
  {
    sku: "JWL-002-B8M2",
    name: "Браслет Line",
    category: "Ювелирка",
    price: "27 400 ₸",
    stock: 2,
    status: "active",
    updatedAt: "Сегодня, 11:10",
    hasVideo: false,
    keywords: ["браслет", "минимализм"],
    thumbnailClass: "bg-indigo-100 text-indigo-700",
  },
  {
    sku: "TEC-005-X4P1",
    name: "Смарт-часы Fit Pro",
    category: "Техника",
    price: "46 900 ₸",
    stock: 0,
    status: "out_of_stock",
    updatedAt: "Вчера, 18:25",
    hasVideo: true,
    keywords: ["часы", "fitness", "bluetooth"],
    thumbnailClass: "bg-cyan-100 text-cyan-700",
  },
  {
    sku: "ACC-003-Q9R5",
    name: "Кожаный ремешок",
    category: "Аксессуары",
    price: "8 500 ₸",
    stock: 14,
    status: "hidden",
    updatedAt: "07.05.2026",
    hasVideo: false,
    keywords: ["ремешок", "кожа"],
    thumbnailClass: "bg-slate-100 text-slate-600",
  },
  {
    sku: "TEC-006-M2C7",
    name: "Портативная колонка Mini",
    category: "Техника",
    price: "18 900 ₸",
    stock: 5,
    status: "draft",
    updatedAt: "06.05.2026",
    hasVideo: true,
    keywords: ["колонка", "звук", "portable"],
    thumbnailClass: "bg-sky-100 text-sky-700",
  },
  {
    sku: "ACC-004-L6N3",
    name: "Футляр Travel Case",
    category: "Аксессуары",
    price: "6 900 ₸",
    stock: 21,
    status: "active",
    updatedAt: "05.05.2026",
    hasVideo: false,
    keywords: ["футляр", "чехол", "travel"],
    thumbnailClass: "bg-emerald-100 text-emerald-700",
  },
];

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

export default function ProductsPage() {
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

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Рабочая таблица каталога</CardTitle>
              <CardDescription>Найдено товаров: {products.length}</CardDescription>
            </div>
            <Badge className="w-fit bg-blue-50 text-blue-700">Mock data</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Поиск по названию, SKU и ключевым словам" />
            </div>
            <select className={filterSelectClass} defaultValue="">
              <option value="">Все категории</option>
              <option value="jewelry">Ювелирка</option>
              <option value="tech">Техника</option>
              <option value="accessories">Аксессуары</option>
            </select>
            <select className={filterSelectClass} defaultValue="">
              <option value="">Все статусы</option>
              <option value="active">Активен</option>
              <option value="hidden">Скрыт</option>
              <option value="out_of_stock">Нет в наличии</option>
              <option value="draft">Черновик</option>
            </select>
            <select className={filterSelectClass} defaultValue="">
              <option value="">Любое наличие</option>
              <option value="in_stock">В наличии</option>
              <option value="low_stock">Мало в наличии</option>
              <option value="out_of_stock">Нет в наличии</option>
            </select>
            <Button variant="outline">
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
                  {products.map((product) => {
                    const status = statusMap[product.status];

                    return (
                      <tr key={product.sku} className="border-t align-middle hover:bg-slate-50/70">
                        <td className="px-4 py-3">
                          <div
                            className={cn(
                              "flex size-12 items-center justify-center rounded-md text-xs font-semibold",
                              product.thumbnailClass,
                            )}
                          >
                            <ImageIcon className="size-5" />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div
                            className={cn(
                              "flex size-9 items-center justify-center rounded-md",
                              product.hasVideo
                                ? "bg-blue-50 text-blue-700"
                                : "bg-slate-100 text-muted-foreground",
                            )}
                            title={product.hasVideo ? "Видео добавлено" : "Видео нет"}
                          >
                            {product.hasVideo ? <Video className="size-4" /> : <VideoOff className="size-4" />}
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
                        <td className="px-4 py-3">{product.category}</td>
                        <td className="px-4 py-3 font-medium">{product.price}</td>
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
                          <Badge className={status.className}>{status.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{product.updatedAt}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" aria-label="Открыть">
                              <Eye />
                            </Button>
                            <Button asChild variant="ghost" size="icon" aria-label="Редактировать">
                              <Link href={`/dashboard/products/${product.sku}/edit`}>
                                <Edit3 />
                              </Link>
                            </Button>
                            <Button variant="ghost" size="icon" aria-label="Скрыть">
                              <EyeOff />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label="Удалить">
                              <Trash2 />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-muted-foreground">Показано 1-6 из {products.length} товаров</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled>
                Назад
              </Button>
              <Button size="sm">1</Button>
              <Button variant="outline" size="sm">
                2
              </Button>
              <Button variant="outline" size="sm">
                Вперед
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Loading state</CardTitle>
            <CardDescription>Mock-состояние для будущей загрузки товаров.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[1, 2, 3].map((item) => (
              <div key={item} className="flex items-center gap-3 rounded-lg border bg-white p-3">
                <div className="size-11 animate-pulse rounded-md bg-slate-200" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
                </div>
                <MoreHorizontal className="size-5 text-muted-foreground" />
              </div>
            ))}
          </CardContent>
        </Card>

        <EmptyState
          icon={PackageOpen}
          title="Товары не найдены"
          description="Так будет выглядеть пустое состояние после поиска или фильтрации без результатов."
        />
      </div>
    </>
  );
}
