"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Copy, Info, PlayCircle, ShieldCheck } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { logAppError } from "@/lib/errors";

const baseEndpoint = "http://localhost:3001/api/public/products";

const endpoints = [
  { method: "GET", path: "/api/public/products", description: "список активных товаров" },
  { method: "GET", path: "/api/public/products?query=кольцо", description: "поиск по названию, SKU, описанию и keywords" },
  { method: "GET", path: "/api/public/products?sku=JWL-001-4937", description: "поиск по артикулу" },
  { method: "GET", path: "/api/public/products?in_stock=true", description: "только товары в наличии" },
  { method: "GET", path: "/api/public/products/[id]", description: "один товар по ID" },
];

const curlExample = `curl -X GET "${baseEndpoint}" \\
  -H "Accept: application/json"`;

const responseJson = `{
  "products": [
    {
      "id": "...",
      "sku": "JWL-001-4937",
      "name": "Золотое кольцо",
      "category": {
        "id": "...",
        "name": "Кольца",
        "code": "001"
      },
      "price": 24500,
      "stock": 2,
      "status": "active",
      "description": "...",
      "keywords": ["кольцо", "золото"],
      "custom_fields": {
        "proba": "585",
        "weight": "3.2",
        "stone": "Фианит"
      },
      "media": [
        {
          "type": "photo",
          "url": "...",
          "thumbnail_url": "..."
        }
      ]
    }
  ]
}`;

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-slate-950 p-4 text-sm leading-6 text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

export default function ApiPage() {
  const [testResponse, setTestResponse] = useState("");
  const [isTesting, setIsTesting] = useState(false);

  const endpointList = useMemo(() => endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join("\n"), []);

  async function copyText(value: string, message: string) {
    await navigator.clipboard.writeText(value);
    alert(message);
  }

  async function testApi() {
    setIsTesting(true);
    setTestResponse("");

    try {
      const response = await fetch("/api/public/products");
      const data = await response.json();

      setTestResponse(JSON.stringify(data, null, 2));
    } catch (error) {
      logAppError("Dashboard API test error", error);
      setTestResponse(JSON.stringify({ error: "Не удалось проверить API" }, null, 2));
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <>
      <PageHeader
        badge="Read-only API"
        title="API для ИИ"
        description="Публичный GET API для внешнего AI-бота, который читает каталог товаров."
      />

      <Card className="mb-6 border-blue-100 bg-blue-50/50">
        <CardContent className="flex gap-3 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
            <Info className="size-5" />
          </div>
          <div className="text-sm text-muted-foreground">
            <p>API пока работает без API key и авторизации. Доступ только на чтение.</p>
            <p className="mt-1">API отдаёт только товары со status = active и is_visible_in_api = true.</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>Базовый endpoint</CardTitle>
                <CardDescription>Используйте этот адрес для подключения внешнего AI-бота.</CardDescription>
              </div>
              <Badge className="gap-1 bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="size-3" />
                GET
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 rounded-lg border bg-white p-4 md:flex-row md:items-center md:justify-between">
              <code className="min-w-0 truncate text-sm">{baseEndpoint}</code>
              <Button variant="outline" size="sm" onClick={() => void copyText(baseEndpoint, "Endpoint скопирован.")}>
                <Copy />
                Скопировать
              </Button>
            </div>
            <Button onClick={() => void testApi()} disabled={isTesting}>
              <PlayCircle />
              {isTesting ? "Проверяем" : "Проверить API"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ограничения ответа</CardTitle>
            <CardDescription>Что именно видит внешний AI-бот.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg border bg-blue-50 p-4 text-blue-700">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                Только чтение
              </div>
              <p className="mt-1 text-sm">API не создает, не изменяет и не удаляет товары.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Статус", "active"],
                ["Видимость API", "is_visible_in_api = true"],
                ["Auth", "не используется"],
                ["API key", "позже"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border bg-white p-4">
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-1 text-sm font-semibold">{value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <CardTitle>Endpoint’ы</CardTitle>
                <CardDescription>Реальные GET endpoints публичного каталога.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => void copyText(endpointList, "Endpoint’ы скопированы.")}>
                <Copy />
                Скопировать
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {endpoints.map((endpoint) => (
              <div key={endpoint.path} className="flex flex-col gap-2 rounded-lg border bg-white p-4 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge className="bg-emerald-50 text-emerald-700">{endpoint.method}</Badge>
                  <code className="truncate text-sm">{endpoint.path}</code>
                </div>
                <p className="text-sm text-muted-foreground">{endpoint.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <CardTitle>Curl пример</CardTitle>
                <CardDescription>Минимальная проверка из терминала.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => void copyText(curlExample, "Curl пример скопирован.")}>
                <Copy />
                Скопировать
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <CodeBlock>{curlExample}</CodeBlock>
          </CardContent>
        </Card>
      </div>

      {testResponse ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Ответ проверки API</CardTitle>
            <CardDescription>
              Результат <code>fetch(&quot;/api/public/products&quot;)</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock>{testResponse}</CodeBlock>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Пример ответа JSON</CardTitle>
              <CardDescription>Структура ответа с товаром, keywords, custom_fields и media.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void copyText(responseJson, "JSON пример скопирован.")}>
              <Copy />
              Скопировать
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <CodeBlock>{responseJson}</CodeBlock>
        </CardContent>
      </Card>
    </>
  );
}
