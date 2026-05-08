"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Hash,
  Info,
  Layers3,
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

type CategoryStatus = "active" | "inactive";

type Category = {
  id: string;
  name: string;
  code: string;
  productsCount: number;
  order: number;
  status: CategoryStatus;
};

type CategoryForm = {
  name: string;
  code: string;
  order: string;
  status: CategoryStatus;
};

const initialCategories: Category[] = [
  { id: "rings", name: "Кольца", code: "001", productsCount: 28, order: 1, status: "active" },
  { id: "earrings", name: "Серьги", code: "002", productsCount: 34, order: 2, status: "active" },
  { id: "chains", name: "Цепочки", code: "003", productsCount: 16, order: 3, status: "active" },
  { id: "bracelets", name: "Браслеты", code: "004", productsCount: 22, order: 4, status: "active" },
  { id: "smartphones", name: "Смартфоны", code: "005", productsCount: 11, order: 5, status: "inactive" },
  { id: "accessories", name: "Аксессуары", code: "006", productsCount: 17, order: 6, status: "active" },
];

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

export default function CategoriesPage() {
  const [categories, setCategories] = useState(initialCategories);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof CategoryForm, string>>>({});

  const sortedCategories = useMemo(
    () => [...categories].sort((first, second) => first.order - second.order),
    [categories],
  );

  const isEditing = editingId !== null;

  function openCreateDialog() {
    setEditingId(null);
    setForm({
      ...emptyForm,
      order: String(categories.length + 1),
    });
    setErrors({});
    setIsDialogOpen(true);
  }

  function openEditDialog(category: Category) {
    setEditingId(category.id);
    setForm({
      name: category.name,
      code: category.code,
      order: String(category.order),
      status: category.status,
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
    const normalizedName = form.name.trim().toLowerCase();
    const normalizedCode = form.code.trim();

    if (!form.name.trim()) {
      nextErrors.name = "Название не должно быть пустым";
    }

    if (!normalizedCode) {
      nextErrors.code = "Код категории не должен быть пустым";
    } else if (!/^\d{3}$/.test(normalizedCode)) {
      nextErrors.code = "Код должен быть в формате 001, 002, 003";
    }

    const duplicateName = categories.some(
      (category) => category.id !== editingId && category.name.trim().toLowerCase() === normalizedName,
    );
    const duplicateCode = categories.some(
      (category) => category.id !== editingId && category.code === normalizedCode,
    );

    if (duplicateName) {
      nextErrors.name = "Категория с таким названием уже есть";
    }

    if (duplicateCode) {
      nextErrors.code = "Категория с таким кодом уже есть";
    }

    if (!form.order.trim() || Number.isNaN(Number(form.order))) {
      nextErrors.order = "Порядок должен быть числом";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function saveCategory() {
    if (!validateForm()) {
      return;
    }

    const nextCategory = {
      name: form.name.trim(),
      code: form.code.trim(),
      order: Number(form.order),
      status: form.status,
    };

    if (editingId) {
      setCategories((current) =>
        current.map((category) => (category.id === editingId ? { ...category, ...nextCategory } : category)),
      );
    } else {
      setCategories((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          productsCount: 0,
          ...nextCategory,
        },
      ]);
    }

    closeDialog();
  }

  function deleteCategory(id: string) {
    setCategories((current) => current.filter((category) => category.id !== id));
  }

  function toggleStatus(id: string) {
    setCategories((current) =>
      current.map((category) =>
        category.id === id
          ? { ...category, status: category.status === "active" ? "inactive" : "active" }
          : category,
      ),
    );
  }

  function moveCategory(id: string, direction: "up" | "down") {
    setCategories((current) => {
      const ordered = [...current].sort((first, second) => first.order - second.order);
      const index = ordered.findIndex((category) => category.id === id);
      const swapIndex = direction === "up" ? index - 1 : index + 1;

      if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) {
        return current;
      }

      const currentOrder = ordered[index].order;
      ordered[index].order = ordered[swapIndex].order;
      ordered[swapIndex].order = currentOrder;

      return ordered;
    });
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

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Список категорий</CardTitle>
              <CardDescription>Всего категорий: {categories.length}</CardDescription>
            </div>
            <Badge className="w-fit bg-blue-50 text-blue-700">Mock data</Badge>
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
                  {sortedCategories.map((category) => (
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
                      <td className="px-4 py-3">{category.order}</td>
                      <td className="px-4 py-3">
                        <Badge className={statusClass(category.status)}>{statusLabel(category.status)}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Выше"
                            onClick={() => moveCategory(category.id, "up")}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Ниже"
                            onClick={() => moveCategory(category.id, "down")}
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Включить или выключить"
                            onClick={() => toggleStatus(category.id)}
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
                            onClick={() => deleteCategory(category.id)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
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
              <Button variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button onClick={saveCategory}>{isEditing ? "Сохранить" : "Добавить"}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
