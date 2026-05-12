"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Braces, Code2, Edit3, Eye, Info, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { selectClassName } from "@/components/ui/select-style";
import { Switch } from "@/components/ui/switch";
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { CustomField as DatabaseCustomField, CustomFieldType } from "@/types/database";

type CustomFieldForm = {
  name: string;
  key: string;
  type: CustomFieldType;
  unit: string;
  required: boolean;
  showInApi: boolean;
  order: string;
  optionsText: string;
};

const fieldTypes: CustomFieldType[] = ["text", "number", "select", "boolean"];

const fieldTypeLabels: Record<CustomFieldType, string> = {
  text: "Текст",
  number: "Число",
  select: "Список",
  boolean: "Да / Нет",
};

const emptyForm: CustomFieldForm = {
  name: "",
  key: "",
  type: "text",
  unit: "",
  required: false,
  showInApi: true,
  order: "1",
  optionsText: "",
};

const selectClass = selectClassName;

function boolBadge(value: boolean, trueLabel: string, falseLabel: string) {
  return (
    <Badge className={value ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-700"}>
      {value ? trueLabel : falseLabel}
    </Badge>
  );
}

function getFieldOptions(field: DatabaseCustomField) {
  if (!Array.isArray(field.options)) {
    return [];
  }

  return field.options.filter((option): option is string => typeof option === "string");
}

function getFriendlyErrorMessage(message: string) {
  if (message.includes("custom_fields_company_key_unique")) {
    return "Поле с таким техническим ключом уже есть в этой компании.";
  }

  if (message.includes("custom_fields_company_name_unique")) {
    return "Поле с таким названием уже есть в этой компании.";
  }

  if (message.includes("custom_fields_key_check")) {
    return "Ключ может содержать только латиницу, цифры и underscore.";
  }

  if (message.includes("custom_fields_type_check")) {
    return "Тип поля должен быть text, number, select или boolean.";
  }

  return message;
}

export default function CustomFieldsPage() {
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [fields, setFields] = useState<DatabaseCustomField[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomFieldForm>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof CustomFieldForm, string>>>({});

  const sortedFields = useMemo(
    () => [...fields].sort((first, second) => first.sort_order - second.sort_order),
    [fields],
  );
  const isEditing = editingId !== null;

  function showError(message: string) {
    const friendlyMessage = getFriendlyErrorMessage(message);
    setPageError(friendlyMessage);
    window.alert(friendlyMessage);
  }

  const loadFields = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    let currentCompanyId: string | null = null;

    try {
      currentCompanyId = await getCurrentCompanyId();
    } catch (error) {
      logAppError("Custom fields profile error", error);
      setFields([]);
      setPageError(getErrorMessage(error));
      setIsLoading(false);
      return;
    }

    if (!currentCompanyId) {
      setFields([]);
      setPageError("Компания текущего пользователя не найдена. Войдите заново.");
      setIsLoading(false);
      return;
    }

    setCompanyId(currentCompanyId);

    const { data, error } = await supabase
      .from("custom_fields")
      .select("*")
      .eq("company_id", currentCompanyId)
      .order("sort_order", { ascending: true });

    if (error) {
      setFields([]);
      setIsLoading(false);
      showError(error.message);
      return;
    }

    setFields((data ?? []) as DatabaseCustomField[]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadFields();
  }, [loadFields]);

  function openCreateDialog() {
    setEditingId(null);
    setForm({ ...emptyForm, order: String(fields.length + 1) });
    setErrors({});
    setIsDialogOpen(true);
  }

  function openEditDialog(field: DatabaseCustomField) {
    setEditingId(field.id);
    setForm({
      name: field.name,
      key: field.key,
      type: field.field_type,
      unit: field.unit ?? "",
      required: field.is_required,
      showInApi: field.is_visible_in_api,
      order: String(field.sort_order),
      optionsText: getFieldOptions(field).join("\n"),
    });
    setErrors({});
    setIsDialogOpen(true);
  }

  function closeDialog() {
    setIsDialogOpen(false);
    setEditingId(null);
    setErrors({});
  }

  function updateForm<K extends keyof CustomFieldForm>(field: K, value: CustomFieldForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function parseOptions() {
    return form.optionsText
      .split("\n")
      .map((option) => option.trim())
      .filter(Boolean);
  }

  function validateForm() {
    const nextErrors: Partial<Record<keyof CustomFieldForm, string>> = {};
    const normalizedName = form.name.trim().toLowerCase();
    const normalizedKey = form.key.trim();
    const sortOrder = Number(form.order);

    if (!form.name.trim()) {
      nextErrors.name = "Название не должно быть пустым";
    }

    if (!normalizedKey) {
      nextErrors.key = "Ключ не должен быть пустым";
    } else if (!/^[a-zA-Z0-9_]+$/.test(normalizedKey)) {
      nextErrors.key = "Ключ: только латиница, цифры и underscore";
    }

    if (!fieldTypes.includes(form.type)) {
      nextErrors.type = "Выберите корректный тип поля";
    }

    const duplicateName = fields.some(
      (field) => field.id !== editingId && field.name.trim().toLowerCase() === normalizedName,
    );
    const duplicateKey = fields.some((field) => field.id !== editingId && field.key === normalizedKey);

    if (duplicateName) {
      nextErrors.name = "Поле с таким названием уже есть";
    }

    if (duplicateKey) {
      nextErrors.key = "Поле с таким ключом уже есть";
    }

    if (!form.order.trim() || Number.isNaN(sortOrder) || !Number.isInteger(sortOrder)) {
      nextErrors.order = "Порядок должен быть числом";
    }

    if (form.type === "select" && parseOptions().length < 2) {
      nextErrors.optionsText = "Для списка нужно минимум 2 варианта";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function saveField() {
    if (!companyId) {
      showError("Компания текущего пользователя не найдена.");
      return;
    }

    if (!validateForm()) {
      return;
    }

    setIsSaving(true);
    setPageError(null);

    const payload = {
      name: form.name.trim(),
      key: form.key.trim(),
      field_type: form.type,
      unit: form.unit.trim() || null,
      options: form.type === "select" ? parseOptions() : [],
      is_required: form.required,
      is_visible_in_api: form.showInApi,
      sort_order: Number(form.order),
    };

    const result = editingId
      ? await supabase
          .from("custom_fields")
          .update(payload)
          .eq("id", editingId)
          .eq("company_id", companyId)
      : await supabase.from("custom_fields").insert({
          company_id: companyId,
          ...payload,
        });

    if (result.error) {
      showError(result.error.message);
      setIsSaving(false);
      return;
    }

    closeDialog();
    await loadFields();
    setIsSaving(false);
  }

  async function deleteField(id: string) {
    if (!companyId) {
      showError("Компания текущего пользователя не найдена.");
      return;
    }

    if (!window.confirm("Удалить пользовательское поле?")) {
      return;
    }

    setPageError(null);

    const { error } = await supabase.from("custom_fields").delete().eq("id", id).eq("company_id", companyId);

    if (error) {
      showError(error.message);
      return;
    }

    await loadFields();
  }

  async function toggleRequired(field: DatabaseCustomField) {
    if (!companyId) {
      showError("Компания текущего пользователя не найдена.");
      return;
    }

    setPageError(null);

    const { error } = await supabase
      .from("custom_fields")
      .update({ is_required: !field.is_required })
      .eq("id", field.id)
      .eq("company_id", companyId);

    if (error) {
      showError(error.message);
      return;
    }

    await loadFields();
  }

  async function toggleShowInApi(field: DatabaseCustomField) {
    if (!companyId) {
      showError("Компания текущего пользователя не найдена.");
      return;
    }

    setPageError(null);

    const { error } = await supabase
      .from("custom_fields")
      .update({ is_visible_in_api: !field.is_visible_in_api })
      .eq("id", field.id)
      .eq("company_id", companyId);

    if (error) {
      showError(error.message);
      return;
    }

    await loadFields();
  }

  return (
    <>
      <PageHeader
        badge="Custom fields"
        title="Поля товаров"
        description="Настройка дополнительных характеристик товаров для разных ниш."
        action={
          <Button onClick={openCreateDialog}>
            <Plus />
            Добавить поле
          </Button>
        }
      />

      <Card className="mb-6 border-blue-100 bg-blue-50/50">
        <CardContent className="flex gap-3 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
            <Info className="size-5" />
          </div>
          <p className="text-sm text-muted-foreground">
            Пользовательские поля позволяют адаптировать карточку товара под любую нишу: ювелирку, технику,
            одежду, мебель и другие категории.
          </p>
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
              <CardTitle>Список полей</CardTitle>
              <CardDescription>Всего полей: {fields.length}</CardDescription>
            </div>
            <Badge className="w-fit bg-blue-50 text-blue-700">Supabase</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Название</th>
                    <th className="px-4 py-3 font-medium">Ключ</th>
                    <th className="px-4 py-3 font-medium">Тип</th>
                    <th className="px-4 py-3 font-medium">Единица</th>
                    <th className="px-4 py-3 font-medium">Обязательное</th>
                    <th className="px-4 py-3 font-medium">Показывать в API</th>
                    <th className="px-4 py-3 font-medium">Порядок</th>
                    <th className="px-4 py-3 text-right font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={8}>
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="size-4 animate-spin" />
                          Загрузка пользовательских полей
                        </span>
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading && sortedFields.length === 0 ? (
                    <tr>
                      <td className="px-4 py-10 text-center text-muted-foreground" colSpan={8}>
                        Поля пока не добавлены
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading
                    ? sortedFields.map((field) => (
                        <tr key={field.id} className="border-t hover:bg-slate-50/70">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
                                <Braces className="size-4" />
                              </div>
                              <span className="font-medium">{field.name}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
                              <Code2 className="size-3" />
                              {field.key}
                            </span>
                          </td>
                          <td className="px-4 py-3">{fieldTypeLabels[field.field_type]}</td>
                          <td className="px-4 py-3 text-muted-foreground">{field.unit || "—"}</td>
                          <td className="px-4 py-3">{boolBadge(field.is_required, "Да", "Нет")}</td>
                          <td className="px-4 py-3">{boolBadge(field.is_visible_in_api, "Да", "Нет")}</td>
                          <td className="px-4 py-3">{field.sort_order}</td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Переключить API"
                                onClick={() => void toggleShowInApi(field)}
                              >
                                <Eye />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Переключить обязательность"
                                onClick={() => void toggleRequired(field)}
                              >
                                <ShieldCheck />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Редактировать"
                                onClick={() => openEditDialog(field)}
                              >
                                <Edit3 />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Удалить"
                                onClick={() => void deleteField(field.id)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    : null}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {isDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border bg-white shadow-soft">
            <div className="flex items-start justify-between gap-4 border-b p-5">
              <div>
                <h2 className="text-lg font-semibold">{isEditing ? "Редактировать поле" : "Добавить поле"}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Поля появятся в карточке товара и могут отдаваться через read-only API.
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Закрыть" onClick={closeDialog}>
                <X />
              </Button>
            </div>
            <div className="grid gap-4 p-5 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium" htmlFor="field-name">
                  Название поля
                </label>
                <Input
                  id="field-name"
                  value={form.name}
                  placeholder="Например: Вес"
                  onChange={(event) => updateForm("name", event.target.value)}
                />
                {errors.name ? <p className="text-xs text-red-600">{errors.name}</p> : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="field-key">
                  Технический ключ
                </label>
                <Input
                  id="field-key"
                  value={form.key}
                  placeholder="weight"
                  onChange={(event) => updateForm("key", event.target.value)}
                />
                {errors.key ? <p className="text-xs text-red-600">{errors.key}</p> : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="field-type">
                  Тип поля
                </label>
                <select
                  id="field-type"
                  className={selectClass}
                  disabled={isSaving}
                  value={form.type}
                  onChange={(event) => updateForm("type", event.target.value as CustomFieldType)}
                >
                  <option value="text">Текст</option>
                  <option value="number">Число</option>
                  <option value="select">Список</option>
                  <option value="boolean">Да / Нет</option>
                </select>
                {errors.type ? <p className="text-xs text-red-600">{errors.type}</p> : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="field-unit">
                  Единица измерения
                </label>
                <Input
                  id="field-unit"
                  value={form.unit}
                  placeholder="г"
                  onChange={(event) => updateForm("unit", event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="field-order">
                  Порядок
                </label>
                <Input
                  id="field-order"
                  value={form.order}
                  placeholder="1"
                  onChange={(event) => updateForm("order", event.target.value)}
                />
                {errors.order ? <p className="text-xs text-red-600">{errors.order}</p> : null}
              </div>
              {form.type === "select" ? (
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium" htmlFor="field-options">
                    Варианты списка
                  </label>
                  <textarea
                    id="field-options"
                    className="min-h-28 w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.optionsText}
                    placeholder={"Белый\nЧерный\nЗолотой"}
                    onChange={(event) => updateForm("optionsText", event.target.value)}
                  />
                  {errors.optionsText ? <p className="text-xs text-red-600">{errors.optionsText}</p> : null}
                </div>
              ) : null}
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-slate-50 p-4">
                <span>
                  <span className="block text-sm font-medium">Обязательное</span>
                  <span className="mt-1 block text-sm text-muted-foreground">Поле нужно заполнить в товаре</span>
                </span>
                <Switch checked={form.required} onCheckedChange={(checked) => updateForm("required", checked)} />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-slate-50 p-4">
                <span>
                  <span className="block text-sm font-medium">Показывать в API</span>
                  <span className="mt-1 block text-sm text-muted-foreground">Передавать поле внешнему AI-боту</span>
                </span>
                <Switch checked={form.showInApi} onCheckedChange={(checked) => updateForm("showInApi", checked)} />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t p-5">
              <Button variant="outline" onClick={closeDialog} disabled={isSaving}>
                Отмена
              </Button>
              <Button onClick={() => void saveField()} disabled={isSaving}>
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
