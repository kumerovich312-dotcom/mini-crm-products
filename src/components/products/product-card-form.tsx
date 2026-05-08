"use client";

import { useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  FileVideo,
  ImageIcon,
  Loader2,
  Play,
  Plus,
  Save,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ProductFormMode = "new" | "edit";
type MediaStatus = "uploaded" | "processing" | "ready" | "failed";

const mediaItems: Array<{
  id: string;
  name: string;
  type: "photo" | "video";
  size: string;
  status: MediaStatus;
  thumbClass: string;
}> = [
  {
    id: "1",
    name: "front-view.jpg",
    type: "photo",
    size: "1.8 MB",
    status: "ready",
    thumbClass: "bg-blue-100 text-blue-700",
  },
  {
    id: "2",
    name: "detail-shot.heic",
    type: "photo",
    size: "2.4 MB",
    status: "processing",
    thumbClass: "bg-indigo-100 text-indigo-700",
  },
  {
    id: "3",
    name: "product-video.mov",
    type: "video",
    size: "18.6 MB",
    status: "uploaded",
    thumbClass: "bg-slate-100 text-slate-700",
  },
  {
    id: "4",
    name: "old-photo.png",
    type: "photo",
    size: "920 KB",
    status: "failed",
    thumbClass: "bg-red-50 text-red-700",
  },
];

const statusView: Record<MediaStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  uploaded: {
    label: "uploaded",
    className: "bg-blue-50 text-blue-700",
    icon: CircleDashed,
  },
  processing: {
    label: "processing",
    className: "bg-amber-50 text-amber-700",
    icon: Loader2,
  },
  ready: {
    label: "ready",
    className: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  failed: {
    label: "failed",
    className: "bg-red-50 text-red-700",
    icon: XCircle,
  },
};

const customFields = [
  { label: "Проба", value: "585" },
  { label: "Вес", value: "3.8 г" },
  { label: "Размер", value: "17.5" },
  { label: "Камень", value: "Фианит" },
];

const selectClass =
  "h-10 rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

function ToggleRow({
  title,
  description,
  defaultChecked,
}: {
  title: string;
  description: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-white p-4">
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
      </span>
      <input
        className="mt-1 size-4 accent-blue-600"
        defaultChecked={defaultChecked}
        type="checkbox"
      />
    </label>
  );
}

export function ProductCardForm({ mode }: { mode: ProductFormMode }) {
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState([
    "кольцо",
    "золотое кольцо",
    "кольцо 585",
    "подарок девушке",
  ]);

  const isEdit = mode === "edit";

  function addKeyword() {
    const nextKeyword = keywordInput.trim();

    if (!nextKeyword || keywords.includes(nextKeyword)) {
      return;
    }

    setKeywords((current) => [...current, nextKeyword]);
    setKeywordInput("");
  }

  function removeKeyword(keyword: string) {
    setKeywords((current) => current.filter((item) => item !== keyword));
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Фото и видео</CardTitle>
            <CardDescription>Mock-загрузка медиа без отправки файлов на сервер.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-6 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
                <UploadCloud className="size-6" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Перетащите фото или видео сюда</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                JPG, PNG, HEIC, MP4, MOV. Обработка медиа будет подключена позже.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button type="button">
                  <ImageIcon />
                  Загрузить фото
                </Button>
                <Button type="button" variant="outline">
                  <FileVideo />
                  Загрузить видео
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {mediaItems.map((item) => {
                const StatusIcon = statusView[item.status].icon;

                return (
                  <div key={item.id} className="flex gap-3 rounded-lg border bg-white p-3">
                    <div
                      className={cn(
                        "relative flex size-16 shrink-0 items-center justify-center rounded-md",
                        item.thumbClass,
                      )}
                    >
                      {item.type === "photo" ? <ImageIcon className="size-6" /> : <Play className="size-6" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.size}</p>
                      <Badge className={cn("mt-2 gap-1", statusView[item.status].className)}>
                        <StatusIcon className={cn("size-3", item.status === "processing" && "animate-spin")} />
                        {statusView[item.status].label}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Основная информация</CardTitle>
            <CardDescription>Название, артикул, категория, цена, остаток и описание.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="name">Название</FieldLabel>
              <Input id="name" defaultValue={isEdit ? "Кольцо Classic" : ""} placeholder="Например: Кольцо Classic" />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="sku">SKU / Артикул</FieldLabel>
              <Input id="sku" defaultValue={isEdit ? "JWL-002-B8M2" : "JWL-001-A7K9"} />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="category">Категория</FieldLabel>
              <select className={selectClass} defaultValue="jewelry" id="category">
                <option value="jewelry">Ювелирка</option>
                <option value="tech">Техника</option>
                <option value="accessories">Аксессуары</option>
              </select>
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="price">Цена</FieldLabel>
              <Input id="price" defaultValue={isEdit ? "31500" : ""} placeholder="0" />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="stock">Остаток</FieldLabel>
              <Input id="stock" defaultValue={isEdit ? "3" : ""} placeholder="0" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="status">Статус</FieldLabel>
              <select className={selectClass} defaultValue={isEdit ? "active" : "draft"} id="status">
                <option value="active">Активен</option>
                <option value="hidden">Скрыт</option>
                <option value="out_of_stock">Нет в наличии</option>
                <option value="draft">Черновик</option>
              </select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="description">Описание</FieldLabel>
              <Textarea
                id="description"
                defaultValue={
                  isEdit
                    ? "Аккуратное золотое кольцо 585 пробы для повседневного образа и подарка."
                    : ""
                }
                placeholder="Краткое описание товара для каталога и API"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Дополнительные поля</CardTitle>
            <CardDescription>Mock custom fields для карточки товара.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {customFields.map((field) => (
              <div key={field.label} className="space-y-2">
                <FieldLabel>{field.label}</FieldLabel>
                <Input defaultValue={field.value} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Ключевые слова</CardTitle>
            <CardDescription>Используются для поиска и read-only API для ИИ.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="Добавить keyword"
              />
              <Button type="button" size="icon" onClick={addKeyword} aria-label="Добавить ключевое слово">
                <Plus />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {keywords.map((keyword) => (
                <Badge key={keyword} className="gap-1 bg-blue-50 text-blue-700">
                  {keyword}
                  <button
                    className="rounded-sm text-blue-700 hover:text-blue-900"
                    type="button"
                    onClick={() => removeKeyword(keyword)}
                    aria-label={`Удалить ${keyword}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Настройки отображения</CardTitle>
            <CardDescription>Контроль видимости товара в каталоге и API.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ToggleRow
              title="Показывать в API"
              description="Товар доступен внешнему AI-боту через read-only API."
              defaultChecked
            />
            <ToggleRow title="Скрыть товар" description="Товар не показывается в публичной выдаче." />
            <ToggleRow title="Черновик" description="Карточка сохранена, но еще не готова к публикации." />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <Button type="button">
              <Save />
              {isEdit ? "Сохранить изменения" : "Создать товар"}
            </Button>
            <Button type="button" variant="outline">
              Сохранить как черновик
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
