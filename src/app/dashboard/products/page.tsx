import Link from "next/link";
import { Plus, Search } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const products = [
  { name: "Серьги Aurora", sku: "JWL-001-A7K9", category: "Серьги", stock: 8, price: "24 900 ₸" },
  { name: "Кольцо Classic", sku: "JWL-002-P2M4", category: "Кольца", stock: 3, price: "31 500 ₸" },
  { name: "Подвеска Moonlight", sku: "JWL-003-K8D1", category: "Подвески", stock: 0, price: "19 000 ₸" },
];

export default function ProductsPage() {
  return (
    <>
      <PageHeader
        badge="Products"
        title="Товары"
        description="Список товаров с артикулами, категориями, ценами и остатками."
        action={
          <Button asChild>
            <Link href="/dashboard/products/new">
              <Plus />
              Добавить товар
            </Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="p-5">
          <div className="relative mb-4 max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="Поиск по названию, SKU, keywords" />
          </div>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full border-collapse bg-white text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Название</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Категория</th>
                  <th className="px-4 py-3 font-medium">Остаток</th>
                  <th className="px-4 py-3 font-medium">Цена</th>
                  <th className="px-4 py-3 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.sku} className="border-t">
                    <td className="px-4 py-3 font-medium">{product.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{product.sku}</td>
                    <td className="px-4 py-3">{product.category}</td>
                    <td className="px-4 py-3">{product.stock}</td>
                    <td className="px-4 py-3">{product.price}</td>
                    <td className="px-4 py-3">
                      <Badge>{product.stock > 0 ? "Активен" : "Нет остатка"}</Badge>
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
