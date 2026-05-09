"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Hash,
  Info,
  Layers3,
  Loader2,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase/client";
import type { Category } from "@/types/database";

const DEFAULT_COMPANY_ID = "718f1a81-3a75-4484-901a-6054936be72c";

type CategoryStatus = "active" | "inactive";

type CategoryItem = Category & {
  productsCount: number;
};

type CategoryForm = {
  name: string;
  code: string;
  order: string;
  status: CategoryStatus;
};

const emptyForm: CategoryForm = {
  name: "",
  code: "",
  order: "1",
  status: "active",
};

function statusClass(status: CategoryStatus) {
  return status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700";
}

function statusLabel(status: CategoryStatus) {
  return status === "active" ? "Активна" : "Выключена";
}

function mapCategoryStatus(category: Category): CategoryStatus {
  return category.is_active ? "active" : "inactive";
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof CategoryForm, string>>>({});

  const sortedCategories = useMemo(
    () => [...categories].sort((first, second) => first.sort_order - second.sort_order),
    [categories],
  );

  const isEditing = editingId !== null;

  const loadCategories = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .eq("company_id", DEFAULT_COMPANY_ID)
      .order("sort_order", { ascending: true });

    if (error) {
      setPageError(error.message);
      setCategories([]);
      setIsLoading(false);
      return;
    }

    const categoryRows = (data ?? []) as Category[];
    const categoriesWithCounts = await Promise.all(
      categoryRows.map(async (category) => {
        const { count } = await supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .eq("company_id", DEFAULT_COMPANY_ID)
          .eq("category_id", category.id);

        return {
          ...category,
          productsCount: count ?? 0,
        };
      }),
    );

    setCategories(categoriesWithCounts);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  function openCreateDialog() {
    setEditingId(null);
    setForm({
      ...emptyForm,
      order: String(categories.length + 1),
    });
    setErrors({});
    setIsDialogOpen(true);
  }

  function openEditDialog(category: CategoryItem) {
    setEditingId(category.id);
    setForm({
      name: category.name,
      code: category.code,
      order: String(category.sort_order),
      status: mapCategoryStatus(category),
    });
    setErrors({});
    setIsDialogOpen(true);
  }

  function closeDialog() {
    setIsDialogOpen(false);
    setEditingId(null);
    setErrors({});
  }

  function updateForm(field: keyof CategoryForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function validateForm() {
    const nextErrors: Partial<Record<keyof CategoryForm, string>> = {};
    const normalizedCode = form.code.trim();

    if (!form.name.trim()) {
      nextErrors.name = "Название не должно быть пустым";
    }

    if (!normalizedCode) {
      nextErrors.code = "Код категории не должен быть пустым";
    } else if (!/^\d{3}$/.test(normalizedCode)) {
      nextErrors.code = "Код должен быть в формате 001, 002, 003";
    }

    const duplicateCode = categories.some(
      (category) => category.id !== editingId && category.company_id === DEFAULT_COMPANY_ID && category.code === normalizedCode,
    );

    if (duplicateCode) {
      nextErrors.code = "Категория с таким кодом уже есть";
    }

    if (!form.order.trim() || Number.isNaN(Number(form.order))) {
      nextErrors.order = "Порядок должен быть числом";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function saveCategory() {
    if (!validateForm()) {
      return;
    }

    setIsSaving(true);
    setPageError(null);

    const payload = {
      name: form.name.trim(),
      code: form.code.trim(),
      sort_order: Number(form.order),
      is_active: form.status === "active",
    };

    const result = editingId
      ? await supabase
          .from("categories")
          .update(payload)
          .eq("id", editingId)
          .eq("company_id", DEFAULT_COMPANY_ID)
      : await supabase.from("categories").insert({
          company_id: DEFAULT_COMPANY_ID,
          ...payload,
        });

    if (result.error) {
      setPageError(result.error.message);
      setIsSaving(false);
      return;
    }

    closeDialog();
    await loadCategories();
    setIsSaving(false);
  }

  async function deleteCategory(id: string) {
    setPageError(null);

    const { error } = await supabase.from("categories").delete().eq("id", id).eq("company_id", DEFAULT_COMPANY_ID);

    if (error) {
      setPageError(error.message);
      return;
    }

    await loadCategories();
  }

  async function toggleStatus(category: CategoryItem) {
    setPageError(null);

    const { error } = await supabase
      .from("categories")
      .update({ is_active: !category.is_active })
      .eq("id", category.id)
      .eq("company_id", DEFAULT_COMPANY_ID);

    if (error) {
      setPageError(error.message);
      return;
    }

    await loadCategories();
  }

  async function moveCategory(category: CategoryItem, direction: "up" | "down") {
    const index = sortedCategories.findIndex((item) => item.id === category.id);
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    const swapCategory = sortedCategories[swapIndex];

    if (!swapCategory) {
      return;
    }

    setPageError(null);

    const firstUpdate = supabase
      .from("categories")
      .update({ sort_order: swapCategory.sort_order })
      .eq("id", category.id)
      .eq("company_id", DEFAULT_COMPANY_ID);

    const secondUpdate = supabase
      .from("categories")
      .update({ sort_order: category.sort_order })
      .eq("id", swapCategory.id)
      .eq("company_id", DEFAULT_COMPANY_ID);

    const [firstResult, secondResult] = await Promise.all([firstUpdate, secondUpdate]);
    const error = firstResult.error ?? secondResult.error;

    if (error) {
      setPageError(error.message);
      return;
    }

    await loadCategories();
  }

  return (
    <>
      <PageHeader
        badge="Каталог"
        title="Категории"
        description="Управление структурой каталога и кодами категорий для артикула."
        action={
          <Button onClick={openCreateDialog}>
            <Plus />
            Добавить категорию
          </Button>
        }
      />

      <Card className="mb-6 border-blue-100 bg-blue-50/50">
        <CardContent className="flex gap-3 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
            <Info className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">Код категории используется в артикуле товара.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Например: <span className="font-mono text-foreground">JWL-001-A7K9</span>, где{" "}
              <span className="font-mono text-foreground">001</span> — код категории.
            </p>
          </div>
        </CardContent>
      </Card>

      {pageError ? (
        <Card className="mb-6 border-red-100 bg-red-50">
          <CardContent className="p-5 text-sm text-red-700">{pageError}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Список категорий</CardTitle>
              <CardDescription>Всего категорий: {categories.length}</CardDescription>
            </div>
            <Badge className="w-fit bg-blue-50 text-blue-700">Supabase</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Название</th>
                    <th className="px-4 py-3 font-medium">Код категории</th>
                    <th className="px-4 py-3 font-medium">Количество товаров</th>
                    <th className="px-4 py-3 font-medium">Порядок</th>
                    <th className="px-4 py-3 font-medium">Статус</th>
                    <th className="px-4 py-3 text-right font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="size-4 animate-spin" />
                          Загрузка категорий
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading && sortedCategories.length === 0 ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                        Категории пока не добавлены
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading
                    ? sortedCategories.map((category) => {
                        const status = mapCategoryStatus(category);

                        return (
                          <tr key={category.id} className="border-t hover:bg-slate-50/70">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <div className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
                                  <Layers3 className="size-4" />
                                </div>
                                <span className="font-medium">{category.name}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
                                <Hash className="size-3" />
                                {category.code}
                              </span>
                            </td>
                            <td className="px-4 py-3">{category.productsCount}</td>
                            <td className="px-4 py-3">{category.sort_order}</td>
                            <td className="px-4 py-3">
                              <Badge className={statusClass(status)}>{statusLabel(status)}</Badge>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Выше"
                                  onClick={() => void moveCategory(category, "up")}
                                >
                                  <ArrowUp />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Ниже"
                                  onClick={() => void moveCategory(category, "down")}
                                >
                                  <ArrowDown />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Включить или выключить"
                                  onClick={() => void toggleStatus(category)}
                                >
                                  <Power />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Редактировать"
                                  onClick={() => openEditDialog(category)}
                                >
                                  <Edit3 />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Удалить"
                                  onClick={() => void deleteCategory(category.id)}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    : null}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {isDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-white shadow-soft">
            <div className="flex items-start justify-between gap-4 border-b p-5">
              <div>
                <h2 className="text-lg font-semibold">
                  {isEditing ? "Редактировать категорию" : "Добавить категорию"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Название и код будут использоваться в структуре каталога и SKU.
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Закрыть" onClick={closeDialog}>
                <X />
              </Button>
            </div>
            <div className="space-y-4 p-5">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="category-name">
                  Название категории
                </label>
                <Input
                  id="category-name"
                  value={form.name}
                  placeholder="Например: Кольца"
                  onChange={(event) => updateForm("name", event.target.value)}
                />
                {errors.name ? <p className="text-xs text-red-600">{errors.name}</p> : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="category-code">
                  Код категории
                </label>
                <Input
                  id="category-code"
                  value={form.code}
                  placeholder="001"
                  maxLength={3}
                  onChange={(event) => updateForm("code", event.target.value)}
                />
                {errors.code ? <p className="text-xs text-red-600">{errors.code}</p> : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="category-order">
                  Порядок
                </label>
                <Input
                  id="category-order"
                  value={form.order}
                  placeholder="1"
                  onChange={(event) => updateForm("order", event.target.value)}
                />
                {errors.order ? <p className="text-xs text-red-600">{errors.order}</p> : null}
              </div>
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-slate-50 p-4">
                <span>
                  <span className="block text-sm font-medium">Статус</span>
                  <span className="mt-1 block text-sm text-muted-foreground">Категория активна в каталоге</span>
                </span>
                <input
                  type="checkbox"
                  className="size-4 accent-blue-600"
                  checked={form.status === "active"}
                  onChange={(event) => updateForm("status", event.target.checked ? "active" : "inactive")}
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t p-5">
              <Button variant="outline" onClick={closeDialog} disabled={isSaving}>
                Отмена
              </Button>
              <Button onClick={() => void saveCategory()} disabled={isSaving}>
                {isSaving ? <Loader2 className="animate-spin" /> : null}
                {isEditing ? "Сохранить" : "Добавить"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
