"use client";

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Info,
  Play,
  UploadCloud,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const steps = [
  "Загрузка файла",
  "Предпросмотр данных",
  "Сопоставление колонок",
  "Проверка ошибок",
  "Результат импорта",
];

const previewRows = [
  {
    name: "Кольцо золотое 585",
    category: "Кольца",
    price: "24500",
    stock: "2",
    proba: "585",
    weight: "3.2",
    size: "17",
    stone: "Фианит",
  },
  {
    name: "Серьги Aurora",
    category: "Серьги",
    price: "18500",
    stock: "1",
    proba: "585",
    weight: "4.1",
    size: "—",
    stone: "Циркон",
  },
  {
    name: "Цепочка Classic",
    category: "Цепочки",
    price: "32000",
    stock: "3",
    proba: "585",
    weight: "7.5",
    size: "—",
    stone: "—",
  },
];

const fileColumns = ["Название", "Категория", "Цена", "Остаток", "Проба", "Вес", "Размер", "Камень"];

const systemFields = [
  { value: "name", label: "name", type: "Системное" },
  { value: "category", label: "category", type: "Системное" },
  { value: "price", label: "price", type: "Системное" },
  { value: "stock", label: "stock", type: "Системное" },
  { value: "description", label: "description", type: "Системное" },
  { value: "keywords", label: "keywords", type: "Системное" },
  { value: "custom_field: proba", label: "custom_field: proba", type: "Пользовательское" },
  { value: "custom_field: weight", label: "custom_field: weight", type: "Пользовательское" },
  { value: "custom_field: ring_size", label: "custom_field: ring_size", type: "Пользовательское" },
  { value: "custom_field: stone", label: "custom_field: stone", type: "Пользовательское" },
];

const initialMapping: Record<string, string> = {
  Название: "name",
  Категория: "category",
  Цена: "price",
  Остаток: "stock",
  Проба: "custom_field: proba",
  Вес: "custom_field: weight",
  Размер: "custom_field: ring_size",
  Камень: "custom_field: stone",
};

const mockErrors = [
  {
    row: 12,
    field: "Цена",
    value: "двадцать",
    error: "Цена должна быть числом",
    recommendation: "Замените значение на число, например 20000",
  },
  {
    row: 18,
    field: "Остаток",
    value: "-5",
    error: "Остаток не может быть отрицательным",
    recommendation: "Укажите 0 или положительное число",
  },
  {
    row: 27,
    field: "Категория",
    value: "Украшения",
    error: "Категория не найдена",
    recommendation: "Создайте категорию или выберите существующую",
  },
  {
    row: 41,
    field: "Проба",
    value: "пусто",
    error: "Обязательное поле не заполнено",
    recommendation: "Заполните пробу или отключите обязательность поля",
  },
];

const summary = [
  { label: "Всего строк", value: "320" },
  { label: "Успешно", value: "302" },
  { label: "С ошибками", value: "18" },
  { label: "Создано товаров", value: "250" },
  { label: "Обновлено товаров", value: "52" },
];

const selectClass =
  "h-10 w-full rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function ImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: string } | null>(null);
  const [mapping, setMapping] = useState(initialMapping);

  const progress = useMemo(() => ((step + 1) / steps.length) * 100, [step]);

  function chooseFile(file: File | undefined) {
    if (!file) {
      return;
    }

    setSelectedFile({
      name: file.name,
      size: formatFileSize(file.size),
    });
  }

  function nextStep() {
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  function prevStep() {
    setStep((current) => Math.max(current - 1, 0));
  }

  function finishImport() {
    setStep(0);
    setSelectedFile(null);
    setMapping(initialMapping);
  }

  return (
    <>
      <PageHeader
        badge="Import"
        title="Импорт товаров"
        description="Массовая загрузка товаров, цен, остатков и характеристик из Excel или CSV."
      />

      <Card className="mb-6 border-blue-100 bg-blue-50/50">
        <CardContent className="flex gap-3 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
            <Info className="size-5" />
          </div>
          <p className="text-sm text-muted-foreground">
            Импорт позволяет быстро оцифровать каталог. Сначала загрузите Excel/CSV, затем сопоставьте колонки с
            полями системы.
          </p>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardContent className="p-5">
          <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            {steps.map((label, index) => (
              <div
                key={label}
                className={`rounded-lg border p-3 ${
                  index === step
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : index < step
                      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                      : "bg-white text-muted-foreground"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-white text-xs font-semibold">
                    {index + 1}
                  </span>
                  <span className="text-sm font-medium">{label}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 1 — Загрузка файла</CardTitle>
            <CardDescription>Выберите Excel или CSV. Реальный парсинг будет подключен позже.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            <div
              className="rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-8 text-center"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                chooseFile(event.dataTransfer.files[0]);
              }}
            >
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
                <UploadCloud className="size-6" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Перетащите Excel/CSV файл сюда</h3>
              <p className="mt-1 text-sm text-muted-foreground">Поддерживаются .xlsx, .xls и .csv</p>
              <Button className="mt-4" type="button" onClick={() => inputRef.current?.click()}>
                <FileSpreadsheet />
                Выбрать файл
              </Button>
            </div>
            {selectedFile ? (
              <div className="flex items-center justify-between rounded-lg border bg-white p-4">
                <div>
                  <p className="text-sm font-medium">{selectedFile.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{selectedFile.size}</p>
                </div>
                <Badge className="bg-blue-50 text-blue-700">Файл выбран</Badge>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 2 — Предпросмотр данных</CardTitle>
            <CardDescription>Первые строки файла в mock-режиме.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse bg-white text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Название</th>
                      <th className="px-4 py-3 font-medium">Категория</th>
                      <th className="px-4 py-3 font-medium">Цена</th>
                      <th className="px-4 py-3 font-medium">Остаток</th>
                      <th className="px-4 py-3 font-medium">Проба</th>
                      <th className="px-4 py-3 font-medium">Вес</th>
                      <th className="px-4 py-3 font-medium">Размер</th>
                      <th className="px-4 py-3 font-medium">Камень</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row) => (
                      <tr key={row.name} className="border-t">
                        <td className="px-4 py-3 font-medium">{row.name}</td>
                        <td className="px-4 py-3">{row.category}</td>
                        <td className="px-4 py-3">{row.price}</td>
                        <td className="px-4 py-3">{row.stock}</td>
                        <td className="px-4 py-3">{row.proba}</td>
                        <td className="px-4 py-3">{row.weight}</td>
                        <td className="px-4 py-3">{row.size}</td>
                        <td className="px-4 py-3">{row.stone}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 3 — Сопоставление колонок</CardTitle>
            <CardDescription>Свяжите колонки файла с полями системы.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Колонка файла</th>
                    <th className="px-4 py-3 font-medium">Поле системы</th>
                    <th className="px-4 py-3 font-medium">Тип поля</th>
                    <th className="px-4 py-3 font-medium">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {fileColumns.map((column) => {
                    const selectedField = systemFields.find((field) => field.value === mapping[column]);

                    return (
                      <tr key={column} className="border-t">
                        <td className="px-4 py-3 font-medium">{column}</td>
                        <td className="px-4 py-3">
                          <select
                            className={selectClass}
                            value={mapping[column]}
                            onChange={(event) =>
                              setMapping((current) => ({ ...current, [column]: event.target.value }))
                            }
                          >
                            {systemFields.map((field) => (
                              <option key={field.value} value={field.value}>
                                {field.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{selectedField?.type}</td>
                        <td className="px-4 py-3">
                          <Badge className="bg-emerald-50 text-emerald-700">Сопоставлено</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 4 — Проверка ошибок</CardTitle>
            <CardDescription>Mock-результаты проверки перед импортом.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse bg-white text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Строка</th>
                      <th className="px-4 py-3 font-medium">Поле</th>
                      <th className="px-4 py-3 font-medium">Значение</th>
                      <th className="px-4 py-3 font-medium">Ошибка</th>
                      <th className="px-4 py-3 font-medium">Рекомендация</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mockErrors.map((item) => (
                      <tr key={`${item.row}-${item.field}`} className="border-t">
                        <td className="px-4 py-3">{item.row}</td>
                        <td className="px-4 py-3 font-medium">{item.field}</td>
                        <td className="px-4 py-3 text-muted-foreground">{item.value}</td>
                        <td className="px-4 py-3 text-red-700">{item.error}</td>
                        <td className="px-4 py-3">{item.recommendation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 5 — Результат импорта</CardTitle>
            <CardDescription>Итоговые показатели mock-импорта.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {summary.map((item) => (
                <Card key={item.label}>
                  <CardContent className="p-5">
                    <p className="text-sm text-muted-foreground">{item.label}</p>
                    <p className="mt-2 text-2xl font-semibold">{item.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={prevStep} disabled={step === 0}>
          <ArrowLeft />
          Назад
        </Button>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {step === 2 ? (
            <Button onClick={nextStep}>
              <AlertTriangle />
              Запустить проверку
            </Button>
          ) : null}
          {step === 3 ? (
            <Button onClick={nextStep}>
              <Play />
              Запустить импорт
            </Button>
          ) : null}
          {step < 2 ? (
            <Button onClick={nextStep} disabled={step === 0 && !selectedFile}>
              Продолжить
              <ArrowRight />
            </Button>
          ) : null}
          {step === 4 ? (
            <Button onClick={finishImport}>
              <CheckCircle2 />
              Завершить
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
