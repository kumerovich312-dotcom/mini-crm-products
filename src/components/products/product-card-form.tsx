"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  CircleDashed,
  FileVideo,
  ImageIcon,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
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
type MediaType = "photo" | "video";

type MediaItem = {
  id: string;
  name: string;
  type: MediaType;
  size: string;
  status: MediaStatus;
  previewUrl?: string;
};

type ProductFormState = {
  name: string;
  sku: string;
  category: string;
  price: string;
  stock: string;
  status: string;
  description: string;
};

type CustomFieldsState = {
  assay: string;
  weight: string;
  size: string;
  stone: string;
};

type VisibilityState = {
  showInApi: boolean;
  hidden: boolean;
  draft: boolean;
};

const statusView: Record<MediaStatus, { label: string; className: string; icon: LucideIcon }> = {
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

const selectClass =
  "h-10 rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

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
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-white p-4">
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
      </span>
      <input
        checked={checked}
        className="mt-1 size-4 accent-blue-600"
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function ProductCardForm({ mode }: { mode: ProductFormMode }) {
  const isEdit = mode === "edit";
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState([
    "кольцо",
    "золотое кольцо",
    "кольцо 585",
    "подарок девушке",
  ]);
  const [media, setMedia] = useState<MediaItem[]>([
    {
      id: "mock-photo",
      name: "front-view.jpg",
      type: "photo",
      size: "1.8 MB",
      status: "ready",
    },
    {
      id: "mock-video",
      name: "product-video.mov",
      type: "video",
      size: "18.6 MB",
      status: "uploaded",
    },
  ]);
  const [form, setForm] = useState<ProductFormState>({
    name: isEdit ? "Кольцо Classic" : "",
    sku: isEdit ? "JWL-002-B8M2" : "JWL-001-A7K9",
    category: "jewelry",
    price: isEdit ? "31500" : "",
    stock: isEdit ? "3" : "",
    status: isEdit ? "active" : "draft",
    description: isEdit
      ? "Аккуратное золотое кольцо 585 пробы для повседневного образа и подарка."
      : "",
  });
  const [customFields, setCustomFields] = useState<CustomFieldsState>({
    assay: "585",
    weight: "3.8 г",
    size: "17.5",
    stone: "Фианит",
  });
  const [visibility, setVisibility] = useState<VisibilityState>({
    showInApi: true,
    hidden: false,
    draft: !isEdit,
  });

  useEffect(() => {
    const previewUrls = previewUrlsRef.current;

    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.clear();
    };
  }, []);

  function updateForm(field: keyof ProductFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateCustomField(field: keyof CustomFieldsState, value: string) {
    setCustomFields((current) => ({ ...current, [field]: value }));
  }

  function updateVisibility(field: keyof VisibilityState, value: boolean) {
    setVisibility((current) => ({ ...current, [field]: value }));
  }

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

  function addFiles(files: FileList | null, type: MediaType) {
    if (!files?.length) {
      return;
    }

    const nextMedia = Array.from(files).map((file) => {
      const previewUrl = type === "photo" ? URL.createObjectURL(file) : undefined;

      if (previewUrl) {
        previewUrlsRef.current.add(previewUrl);
      }

      return {
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        name: file.name,
        type,
        size: formatFileSize(file.size),
        status: "uploaded" as const,
        previewUrl,
      };
    });

    setMedia((current) => [...nextMedia, ...current]);
  }

  function removeMedia(id: string) {
    setMedia((current) => {
      const item = current.find((mediaItem) => mediaItem.id === id);

      if (item?.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previewUrlsRef.current.delete(item.previewUrl);
      }

      return current.filter((mediaItem) => mediaItem.id !== id);
    });
  }

  function handleSave() {
    alert("Товар сохранён локально. Подключение к базе будет позже.");
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Фото и видео</CardTitle>
            <CardDescription>Локальная mock-загрузка без отправки файлов на сервер.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <input
              ref={photoInputRef}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/heic,image/webp"
              multiple
              onChange={(event) => {
                addFiles(event.target.files, "photo");
                event.target.value = "";
              }}
            />
            <input
              ref={videoInputRef}
              className="hidden"
              type="file"
              accept="video/mp4,video/quicktime"
              multiple
              onChange={(event) => {
                addFiles(event.target.files, "video");
                event.target.value = "";
              }}
            />

            <div className="rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-6 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
                <UploadCloud className="size-6" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Перетащите фото или видео сюда</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                JPG, PNG, HEIC, WebP, MP4, MOV. Реальная обработка медиа будет подключена позже.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button type="button" onClick={() => photoInputRef.current?.click()}>
                  <ImageIcon />
                  Загрузить фото
                </Button>
                <Button type="button" variant="outline" onClick={() => videoInputRef.current?.click()}>
                  <FileVideo />
                  Загрузить видео
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {media.map((item) => {
                const StatusIcon = statusView[item.status].icon;

                return (
                  <div key={item.id} className="flex gap-3 rounded-lg border bg-white p-3">
                    <div className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-blue-50 text-blue-700">
                      {item.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt={item.name} className="size-full object-cover" src={item.previewUrl} />
                      ) : item.type === "photo" ? (
                        <ImageIcon className="size-6" />
                      ) : (
                        <Play className="size-6" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{item.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.type === "photo" ? "photo" : "video"} · {item.size}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Удалить медиа"
                          onClick={() => removeMedia(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
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
              <Input
                id="name"
                value={form.name}
                placeholder="Например: Кольцо Classic"
                onChange={(event) => updateForm("name", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="sku">SKU / Артикул</FieldLabel>
              <Input id="sku" value={form.sku} onChange={(event) => updateForm("sku", event.target.value)} />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="category">Категория</FieldLabel>
              <select
                className={selectClass}
                id="category"
                value={form.category}
                onChange={(event) => updateForm("category", event.target.value)}
              >
                <option value="jewelry">Ювелирка</option>
                <option value="tech">Техника</option>
                <option value="accessories">Аксессуары</option>
              </select>
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="price">Цена</FieldLabel>
              <Input
                id="price"
                value={form.price}
                placeholder="0"
                onChange={(event) => updateForm("price", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="stock">Остаток</FieldLabel>
              <Input
                id="stock"
                value={form.stock}
                placeholder="0"
                onChange={(event) => updateForm("stock", event.target.value)}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <FieldLabel htmlFor="status">Статус</FieldLabel>
              <select
                className={selectClass}
                id="status"
                value={form.status}
                onChange={(event) => updateForm("status", event.target.value)}
              >
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
                value={form.description}
                placeholder="Краткое описание товара для каталога и API"
                onChange={(event) => updateForm("description", event.target.value)}
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
            <div className="space-y-2">
              <FieldLabel htmlFor="assay">Проба</FieldLabel>
              <Input
                id="assay"
                value={customFields.assay}
                onChange={(event) => updateCustomField("assay", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="weight">Вес</FieldLabel>
              <Input
                id="weight"
                value={customFields.weight}
                onChange={(event) => updateCustomField("weight", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="size">Размер</FieldLabel>
              <Input
                id="size"
                value={customFields.size}
                onChange={(event) => updateCustomField("size", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="stone">Камень</FieldLabel>
              <Input
                id="stone"
                value={customFields.stone}
                onChange={(event) => updateCustomField("stone", event.target.value)}
              />
            </div>
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
              checked={visibility.showInApi}
              onChange={(checked) => updateVisibility("showInApi", checked)}
            />
            <ToggleRow
              title="Скрыть товар"
              description="Товар не показывается в публичной выдаче."
              checked={visibility.hidden}
              onChange={(checked) => updateVisibility("hidden", checked)}
            />
            <ToggleRow
              title="Черновик"
              description="Карточка сохранена, но еще не готова к публикации."
              checked={visibility.draft}
              onChange={(checked) => updateVisibility("draft", checked)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <Button type="button" onClick={handleSave}>
              <Save />
              Сохранить
            </Button>
            <Button asChild type="button" variant="outline">
              <Link href="/dashboard/products">Отмена</Link>
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
