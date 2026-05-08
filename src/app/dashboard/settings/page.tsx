import { Building2, Save } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        badge="Settings"
        title="Настройки"
        description="Базовые настройки компании и префикс для генерации артикулов."
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Building2 className="size-5" />
            </div>
            <div>
              <CardTitle>Компания</CardTitle>
              <CardDescription>Mock-форма без сохранения.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="company-name">
              Название компании
            </label>
            <Input id="company-name" defaultValue="JWL Company" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="sku-prefix">
              SKU-префикс
            </label>
            <Input id="sku-prefix" defaultValue="JWL" />
          </div>
          <Button>
            <Save />
            Сохранить
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
