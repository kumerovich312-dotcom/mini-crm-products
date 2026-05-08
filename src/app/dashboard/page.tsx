import { Boxes, CircleDollarSign, Layers3, PackageCheck } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const stats = [
  { label: "Товары", value: "128", icon: Boxes },
  { label: "В наличии", value: "94", icon: PackageCheck },
  { label: "Категории", value: "12", icon: Layers3 },
  { label: "Средняя цена", value: "18 400 ₸", icon: CircleDollarSign },
];

const recentProducts = ["Серьги Aurora", "Кольцо Classic", "Подвеска Moonlight"];

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        badge="Dashboard"
        title="Обзор каталога"
        description="Краткая сводка по товарам, остаткам и свежим позициям. Данные пока демонстрационные."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label}>
              <CardContent className="flex items-center justify-between p-5">
                <div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="mt-2 text-2xl font-semibold">{stat.value}</p>
                </div>
                <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Недавно добавленные товары</CardTitle>
          <CardDescription>Пример блока для будущей активности каталога.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {recentProducts.map((product) => (
            <div key={product} className="flex items-center justify-between rounded-md border bg-white p-3">
              <div>
                <p className="text-sm font-medium">{product}</p>
                <p className="text-xs text-muted-foreground">JWL-001-A7K9</p>
              </div>
              <Badge>В API</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
