import { Copy, KeyRound } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ApiPage() {
  return (
    <>
      <PageHeader
        badge="Read-only API"
        title="API для ИИ"
        description="Настройки доступа внешнего AI-бота к каталогу товаров только на чтение."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle>API-ключ</CardTitle>
            <CardDescription>Демонстрационный ключ, без реальной авторизации.</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3 rounded-md border bg-slate-50 p-4 font-mono text-sm">
            <span className="truncate">sk_demo_products_readonly</span>
            <Button variant="outline" size="sm">
              <Copy />
              Скопировать
            </Button>
          </CardContent>
        </Card>
        <EmptyState
          icon={KeyRound}
          title="Endpoints будут реализованы позже"
          description="Планируемые фильтры: query, in_stock, category, sku."
        />
      </div>
    </>
  );
}
