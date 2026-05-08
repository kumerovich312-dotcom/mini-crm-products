"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Info,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ExampleTab = "curl" | "javascript" | "python";

const initialKey = "sk_read_jwl_7f9c2a9b6d4e3f1a";

const endpoints = [
  { path: "/api/public/products", description: "список всех товаров" },
  { path: "/api/public/products/{id}", description: "товар по ID" },
  { path: "/api/public/products?query=iphone", description: "поиск по запросу" },
  { path: "/api/public/products?in_stock=true", description: "товары в наличии" },
  { path: "/api/public/products?category=smartphones", description: "фильтр по категории" },
  { path: "/api/public/products?sku=JWL-001-A7K9", description: "поиск по артикулу" },
];

const searchableFields = ["name", "sku", "description", "category", "keywords", "custom_fields"];

const responseJson = `{
  "products": [
    {
      "id": "prd_123",
      "sku": "JWL-001-A7K9",
      "name": "Золотое кольцо 585 с фианитом",
      "category": "Кольца",
      "price": 24500,
      "stock": 2,
      "status": "active",
      "description": "Элегантное золотое кольцо 585 пробы с фианитом.",
      "keywords": ["кольцо", "золотое кольцо", "кольцо 585"],
      "custom_fields": {
        "proba": "585",
        "weight": "3.2 г",
        "ring_size": "17",
        "stone": "Фианит"
      },
      "media": [
        {
          "type": "photo",
          "url": "https://cdn.site.com/products/photo.webp",
          "thumbnail_url": "https://cdn.site.com/products/thumb.webp"
        }
      ]
    }
  ]
}`;

function maskKey(key: string) {
  return `${key.slice(0, 12)}••••••••••••${key.slice(-4)}`;
}

function generateMockKey() {
  const randomPart = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `sk_read_jwl_${randomPart}`;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-slate-950 p-4 text-sm leading-6 text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

export default function ApiPage() {
  const [apiKey, setApiKey] = useState(initialKey);
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<ExampleTab>("curl");

  const examples = useMemo(
    () => ({
      curl: `curl -X GET "https://your-domain.com/api/public/products?query=кольцо" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Accept: application/json"`,
      javascript: `const response = await fetch("https://your-domain.com/api/public/products?query=кольцо", {
  headers: {
    Authorization: "Bearer ${apiKey}",
    Accept: "application/json"
  }
});

const data = await response.json();`,
      python: `import requests

response = requests.get(
    "https://your-domain.com/api/public/products",
    params={"query": "кольцо"},
    headers={
        "Authorization": "Bearer ${apiKey}",
        "Accept": "application/json",
    },
)

data = response.json()`,
    }),
    [apiKey],
  );

  async function copyKey() {
    await navigator.clipboard.writeText(apiKey);
    alert("API ключ скопирован.");
  }

  function regenerateKey() {
    setApiKey(generateMockKey());
    setIsKeyVisible(true);
    alert("Новый mock API ключ сгенерирован.");
  }

  return (
    <>
      <PageHeader
        badge="Read-only API"
        title="API для ИИ"
        description="Read-only доступ к каталогу товаров для внешнего AI-бота или сайта."
      />

      <Card className="mb-6 border-blue-100 bg-blue-50/50">
        <CardContent className="flex gap-3 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
            <Info className="size-5" />
          </div>
          <p className="text-sm text-muted-foreground">
            API работает только на чтение. Через этот ключ нельзя создавать, изменять или удалять товары.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>API ключ</CardTitle>
                <CardDescription>Демонстрационный ключ для будущего read-only доступа.</CardDescription>
              </div>
              <Badge className="gap-1 bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="size-3" />
                Активен
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-slate-50 p-4">
              <p className="text-sm text-muted-foreground">Название ключа</p>
              <p className="mt-1 text-sm font-medium">JWL read-only catalog key</p>
            </div>
            <div className="flex flex-col gap-3 rounded-lg border bg-white p-4 md:flex-row md:items-center md:justify-between">
              <code className="min-w-0 truncate text-sm">{isKeyVisible ? apiKey : maskKey(apiKey)}</code>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setIsKeyVisible((current) => !current)}>
                  {isKeyVisible ? <EyeOff /> : <Eye />}
                  {isKeyVisible ? "Скрыть" : "Показать"}
                </Button>
                <Button variant="outline" size="sm" onClick={copyKey}>
                  <Copy />
                  Скопировать
                </Button>
              </div>
            </div>
            <Button onClick={regenerateKey}>
              <RefreshCw />
              Сгенерировать новый ключ
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Настройки доступа</CardTitle>
            <CardDescription>Ограничения и статистика использования ключа.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {[
              ["Доступ", "Только чтение"],
              ["Лимит запросов", "5 000 / день"],
              ["Использовано сегодня", "123"],
              ["Последнее использование", "Сегодня, 12:30"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border bg-white p-4">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="mt-1 text-sm font-semibold">{value}</p>
              </div>
            ))}
            <div className="rounded-lg border bg-blue-50 p-4 text-blue-700 sm:col-span-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                Только чтение
              </div>
              <p className="mt-1 text-sm">Ключ предназначен только для получения товаров из каталога.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Endpoint’ы</CardTitle>
            <CardDescription>Планируемые GET endpoints для внешнего AI-бота или сайта.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {endpoints.map((endpoint) => (
              <div key={endpoint.path} className="flex flex-col gap-2 rounded-lg border bg-white p-4 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge className="bg-emerald-50 text-emerald-700">GET</Badge>
                  <code className="truncate text-sm">{endpoint.path}</code>
                </div>
                <p className="text-sm text-muted-foreground">{endpoint.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Поиск работает по</CardTitle>
            <CardDescription>Поля, которые будут участвовать в поиске товаров.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {searchableFields.map((field) => (
              <Badge key={field} className="bg-blue-50 text-blue-700">
                {field}
              </Badge>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Пример запроса</CardTitle>
          <CardDescription>Mock-примеры подключения к read-only API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(["curl", "javascript", "python"] as ExampleTab[]).map((tab) => (
              <Button
                key={tab}
                variant={activeTab === tab ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveTab(tab)}
              >
                {tab === "javascript" ? "JavaScript" : tab}
              </Button>
            ))}
          </div>
          <CodeBlock>{examples[activeTab]}</CodeBlock>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Пример ответа JSON</CardTitle>
          <CardDescription>Структура ответа с товаром, keywords, custom_fields и media.</CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock>{responseJson}</CodeBlock>
        </CardContent>
      </Card>
    </>
  );
}
