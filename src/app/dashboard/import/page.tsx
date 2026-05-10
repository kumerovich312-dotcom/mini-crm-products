"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Info,
  Loader2,
  Play,
  UploadCloud,
} from "lucide-react";
import * as XLSX from "xlsx";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentCompanyId } from "@/lib/auth/get-current-company";
import { getErrorMessage, logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { Category, CustomField, Product, ProductStatus } from "@/types/database";

type ImportRow = Record<string, string>;
type ImportErrorItem = {
  row: number;
  field: string;
  value: string;
  error: string;
};
type ImportResult = {
  totalRows: number;
  successRows: number;
  createdRows: number;
  updatedRows: number;
  errorRows: number;
  errors: ImportErrorItem[];
};

const steps = [
  "Загрузка файла",
  "Предпросмотр данных",
  "Сопоставление колонок",
  "Проверка ошибок",
  "Результат импорта",
];

const standardFields = [
  { value: "name", label: "name", type: "Системное" },
  { value: "sku", label: "sku", type: "Системное" },
  { value: "category", label: "category", type: "Системное" },
  { value: "price", label: "price", type: "Системное" },
  { value: "stock", label: "stock", type: "Системное" },
  { value: "description", label: "description", type: "Системное" },
  { value: "keywords", label: "keywords", type: "Системное" },
  { value: "status", label: "status", type: "Системное" },
];

const selectClass =
  "h-10 w-full rounded-md border border-input bg-white px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function getCell(row: ImportRow, column: string | undefined) {
  return column ? String(row[column] ?? "").trim() : "";
}

function splitKeywords(value: string) {
  return value
    .split(/[,;]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function generateProductCode(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function guessMapping(columns: string[], customFields: CustomField[]) {
  const aliases: Record<string, string[]> = {
    name: ["name", "название", "товар", "наименование"],
    sku: ["sku", "артикул", "код"],
    category: ["category", "категория"],
    price: ["price", "цена"],
    stock: ["stock", "остаток", "количество"],
    description: ["description", "описание"],
    keywords: ["keywords", "ключевые слова"],
    status: ["status", "статус"],
  };

  return columns.reduce<Record<string, string>>((acc, column) => {
    const normalizedColumn = normalize(column);
    const standardField = standardFields.find((field) =>
      aliases[field.value]?.some((alias) => normalizedColumn.includes(alias)),
    );
    const customField = customFields.find(
      (field) => normalizedColumn === normalize(field.key) || normalizedColumn === normalize(field.name),
    );

    acc[column] = standardField?.value ?? (customField ? `custom_field:${customField.key}` : "");
    return acc;
  }, {});
}

function findMappedColumn(mapping: Record<string, string>, field: string) {
  return Object.entries(mapping).find(([, mappedField]) => mappedField === field)?.[0];
}

function buildCategoryMapping(rows: ImportRow[], categoryColumn: string | undefined, categories: Category[]) {
  if (!categoryColumn) {
    return {};
  }

  return Array.from(new Set(rows.map((row) => getCell(row, categoryColumn)).filter(Boolean))).reduce<Record<string, string>>(
    (acc, categoryName) => {
      const matchedCategory = categories.find((category) => normalize(category.name) === normalize(categoryName));
      acc[categoryName] = matchedCategory?.id ?? "";
      return acc;
    },
    {},
  );
}

export default function ImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [selectedFile, setSelectedFile] = useState<{ file: File; name: string; size: string } | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [categoryMapping, setCategoryMapping] = useState<Record<string, string>>({});
  const [defaultCategoryId, setDefaultCategoryId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyPrefix, setCompanyPrefix] = useState("JWL");
  const [existingProducts, setExistingProducts] = useState<Product[]>([]);
  const [validationErrors, setValidationErrors] = useState<ImportErrorItem[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const progress = useMemo(() => ((step + 1) / steps.length) * 100, [step]);
  const systemFields = useMemo(
    () => [
      { value: "", label: "Не импортировать", type: "—" },
      ...standardFields,
      ...customFields.map((field) => ({
        value: `custom_field:${field.key}`,
        label: `custom_field: ${field.key}`,
        type: "Пользовательское",
      })),
    ],
    [customFields],
  );
  const categoryColumn = useMemo(() => findMappedColumn(mapping, "category"), [mapping]);
  const fileCategories = useMemo(() => {
    if (!categoryColumn) {
      return [];
    }

    return Array.from(new Set(rows.map((row) => getCell(row, categoryColumn)).filter(Boolean))).sort((first, second) =>
      first.localeCompare(second, "ru"),
    );
  }, [categoryColumn, rows]);
  const hasUnmappedCategories = useMemo(() => {
    if (!categoryColumn) {
      return !defaultCategoryId;
    }

    return fileCategories.some((category) => !categoryMapping[category]);
  }, [categoryColumn, categoryMapping, defaultCategoryId, fileCategories]);

  const loadReferenceData = useCallback(async () => {
    let currentCompanyId: string | null = null;

    try {
      currentCompanyId = await getCurrentCompanyId();
    } catch (error) {
      logAppError("Import profile error", error);
      setPageError(getErrorMessage(error));
      setCategories([]);
      setCustomFields([]);
      setExistingProducts([]);
      return;
    }

    if (!currentCompanyId) {
      setPageError("Компания текущего пользователя не найдена. Войдите заново.");
      setCategories([]);
      setCustomFields([]);
      setExistingProducts([]);
      return;
    }

    setCompanyId(currentCompanyId);

    const [companyResult, categoriesResult, customFieldsResult, productsResult] = await Promise.all([
      supabase.from("companies").select("sku_prefix").eq("id", currentCompanyId).maybeSingle(),
      supabase.from("categories").select("*").eq("company_id", currentCompanyId).order("sort_order", { ascending: true }),
      supabase.from("custom_fields").select("*").eq("company_id", currentCompanyId).order("sort_order", { ascending: true }),
      supabase.from("products").select("*").eq("company_id", currentCompanyId),
    ]);

    const error = companyResult.error ?? categoriesResult.error ?? customFieldsResult.error ?? productsResult.error;

    if (error) {
      logAppError("Import reference data error", error);
      setPageError(error.message);
      return;
    }

    setCompanyPrefix(companyResult.data?.sku_prefix ?? "JWL");
    setCategories(((categoriesResult.data ?? []) as Category[]) ?? []);
    setCustomFields(((customFieldsResult.data ?? []) as CustomField[]) ?? []);
    setExistingProducts(((productsResult.data ?? []) as Product[]) ?? []);
  }, []);

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  async function chooseFile(file: File | undefined) {
    if (!file) {
      return;
    }

    setPageError(null);
    setValidationErrors([]);
    setResult(null);

    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setPageError("Поддерживаются только .xlsx, .xls и .csv файлы.");
      return;
    }

    setIsBusy(true);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" });
      const header = (rawRows[0] ?? []).map((value) => String(value).trim()).filter(Boolean);
      const parsedRows = rawRows
        .slice(1)
        .map((rawRow) =>
          header.reduce<ImportRow>((acc, column, index) => {
            acc[column] = String(rawRow[index] ?? "").trim();
            return acc;
          }, {}),
        )
        .filter((row) => Object.values(row).some((value) => value.trim()));

      if (header.length === 0 || parsedRows.length === 0) {
        setPageError("Файл пустой или не содержит строк для импорта.");
        return;
      }

      setSelectedFile({ file, name: file.name, size: formatFileSize(file.size) });
      setColumns(header);
      setRows(parsedRows);
      const guessedMapping = guessMapping(header, customFields);
      const guessedCategoryColumn = findMappedColumn(guessedMapping, "category");
      setMapping(guessedMapping);
      setCategoryMapping(buildCategoryMapping(parsedRows, guessedCategoryColumn, categories));
      setDefaultCategoryId("");
      setStep(1);
    } catch (error) {
      logAppError("Import file parse error", error);
      setPageError("Не удалось прочитать файл.");
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshExistingProducts() {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return existingProducts;
    }

    const { data, error } = await supabase.from("products").select("*").eq("company_id", companyId);

    if (error) {
      logAppError("Import products refresh error", error);
      setPageError(error.message);
      return existingProducts;
    }

    const products = ((data ?? []) as Product[]) ?? [];
    setExistingProducts(products);
    return products;
  }

  function validateRows() {
    const errors: ImportErrorItem[] = [];
    const nameColumn = findMappedColumn(mapping, "name");
    const skuColumn = findMappedColumn(mapping, "sku");
    const priceColumn = findMappedColumn(mapping, "price");
    const stockColumn = findMappedColumn(mapping, "stock");
    const seenSkus = new Set<string>();

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const name = getCell(row, nameColumn);
      const sku = getCell(row, skuColumn).toUpperCase();
      const category = getCell(row, categoryColumn);
      const price = getCell(row, priceColumn);
      const stock = getCell(row, stockColumn);

      if (!name) {
        errors.push({ row: rowNumber, field: "name", value: "", error: "Название товара обязательно." });
      }

      if (sku) {
        if (seenSkus.has(sku)) {
          errors.push({ row: rowNumber, field: "sku", value: sku, error: "SKU повторяется в файле." });
        }

        seenSkus.add(sku);
      }

      if (price && Number.isNaN(Number(price))) {
        errors.push({ row: rowNumber, field: "price", value: price, error: "Цена должна быть числом." });
      }

      if (stock && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
        errors.push({ row: rowNumber, field: "stock", value: stock, error: "Остаток должен быть целым числом >= 0." });
      }

      if (categoryColumn) {
        if (category && !categoryMapping[category]) {
          errors.push({ row: rowNumber, field: "category", value: category, error: "Категория не сопоставлена." });
        }
      } else if (!defaultCategoryId) {
        errors.push({ row: rowNumber, field: "category", value: "", error: "Выберите категорию для всех товаров." });
      }

      customFields
        .filter((field) => field.is_required)
        .forEach((field) => {
          const column = findMappedColumn(mapping, `custom_field:${field.key}`);
          const value = getCell(row, column);

          if (!value) {
            errors.push({
              row: rowNumber,
              field: field.key,
              value: "",
              error: "Обязательное пользовательское поле не заполнено.",
            });
          }
        });
    });

    setValidationErrors(errors);
    return errors;
  }

  async function runValidation() {
    if (hasUnmappedCategories) {
      alert("Есть несопоставленные категории. Выберите категорию в системе для каждой категории из файла.");
    }

    setIsBusy(true);
    setPageError(null);

    await refreshExistingProducts();
    validateRows();
    setStep(3);
    setIsBusy(false);
  }

  async function buildUniqueSku(categoryCode: string, usedSkus: Set<string>) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sku = `${companyPrefix}-${categoryCode}-${generateProductCode()}`;

      if (!usedSkus.has(sku)) {
        usedSkus.add(sku);
        return sku;
      }
    }

    const sku = `${companyPrefix}-${categoryCode}-${generateProductCode(6)}`;
    usedSkus.add(sku);
    return sku;
  }

  async function saveCustomValues(productId: string, row: ImportRow) {
    if (!companyId) {
      throw new Error("Компания текущего пользователя не найдена.");
    }

    for (const field of customFields) {
      const column = findMappedColumn(mapping, `custom_field:${field.key}`);
      const rawValue = getCell(row, column);

      if (!column || !rawValue) {
        continue;
      }

      const payload = {
        company_id: companyId,
        product_id: productId,
        custom_field_id: field.id,
        value_text: field.field_type === "text" || field.field_type === "select" ? rawValue : null,
        value_number: field.field_type === "number" ? Number(rawValue) : null,
        value_boolean: field.field_type === "boolean" ? ["true", "1", "yes", "да"].includes(normalize(rawValue)) : null,
        value_date: null,
      };
      const { data: existingValue, error: existingError } = await supabase
        .from("product_custom_values")
        .select("id")
        .eq("company_id", companyId)
        .eq("product_id", productId)
        .eq("custom_field_id", field.id)
        .maybeSingle();

      if (existingError) {
        logAppError("Import custom value lookup error", existingError);
        throw new Error(getErrorMessage(existingError));
      }

      const result = existingValue
        ? await supabase
            .from("product_custom_values")
            .update(payload)
            .eq("id", existingValue.id)
            .eq("company_id", companyId)
        : await supabase.from("product_custom_values").insert(payload);

      if (result.error) {
        logAppError("Import custom value save error", result.error);
        throw new Error(getErrorMessage(result.error));
      }
    }
  }

  async function runImport() {
    if (!companyId) {
      setPageError("Компания текущего пользователя не найдена.");
      return;
    }

    if (hasUnmappedCategories) {
      alert("Есть несопоставленные категории. Выберите категорию в системе для каждой категории из файла.");
      return;
    }

    setIsBusy(true);
    setPageError(null);

    const products = await refreshExistingProducts();
    const errors = validateRows();
    const invalidRows = new Set(errors.map((error) => error.row));
    const nameColumn = findMappedColumn(mapping, "name");
    const skuColumn = findMappedColumn(mapping, "sku");
    const priceColumn = findMappedColumn(mapping, "price");
    const stockColumn = findMappedColumn(mapping, "stock");
    const descriptionColumn = findMappedColumn(mapping, "description");
    const keywordsColumn = findMappedColumn(mapping, "keywords");
    const statusColumn = findMappedColumn(mapping, "status");
    const productBySku = new Map(products.map((product) => [product.sku.toUpperCase(), product]));
    const usedSkus = new Set(products.map((product) => product.sku.toUpperCase()));
    let createdRows = 0;
    let updatedRows = 0;
    const importResult = await supabase
      .from("imports")
      .insert({
        company_id: companyId,
        file_name: selectedFile?.name ?? "import",
        status: "validating",
        total_rows: rows.length,
        success_rows: 0,
        error_rows: errors.length,
      })
      .select("id")
      .single();

    if (importResult.error) {
      logAppError("Import create error", importResult.error);
      setPageError(importResult.error.message);
      setIsBusy(false);
      return;
    }

    const importId = importResult.data.id as string;

    for (const row of rows) {
      const rowNumber = rows.indexOf(row) + 2;

      if (invalidRows.has(rowNumber)) {
        continue;
      }

      const categoryName = getCell(row, categoryColumn);
      const mappedCategoryId = categoryColumn ? categoryMapping[categoryName] : defaultCategoryId;
      const category = categories.find((item) => item.id === mappedCategoryId) ?? null;
      const categoryCode = category?.code ?? "000";
      const skuFromFile = getCell(row, skuColumn).toUpperCase();
      const sku = skuFromFile || (await buildUniqueSku(categoryCode, usedSkus));
      const existingProduct = productBySku.get(sku);
      const rawStatus = getCell(row, statusColumn) as ProductStatus;
      const status: ProductStatus = ["active", "hidden", "out_of_stock", "draft"].includes(rawStatus)
        ? rawStatus
        : "active";
      const payload = {
        company_id: companyId,
        category_id: category?.id ?? null,
        name: getCell(row, nameColumn),
        sku,
        price: Number(getCell(row, priceColumn)) || 0,
        stock: Number(getCell(row, stockColumn)) || 0,
        status,
        description: getCell(row, descriptionColumn) || null,
        keywords: splitKeywords(getCell(row, keywordsColumn)),
        is_visible_in_api: status === "active" || status === "out_of_stock",
      };
      const saveResult = existingProduct
        ? await supabase
            .from("products")
            .update(payload)
            .eq("id", existingProduct.id)
            .eq("company_id", companyId)
            .select("id, sku")
            .single()
        : await supabase.from("products").insert(payload).select("id, sku").single();

      if (saveResult.error) {
        errors.push({ row: rowNumber, field: "product", value: sku, error: saveResult.error.message });
        invalidRows.add(rowNumber);
        continue;
      }

      try {
        await saveCustomValues(saveResult.data.id as string, row);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось сохранить пользовательские поля.";
        errors.push({ row: rowNumber, field: "custom_fields", value: sku, error: message });
        invalidRows.add(rowNumber);
        continue;
      }

      if (existingProduct) {
        updatedRows += 1;
      } else {
        createdRows += 1;
      }
    }

    if (errors.length > 0) {
      await supabase.from("import_errors").insert(
        errors.map((error) => ({
          company_id: companyId,
          import_id: importId,
          row_number: error.row,
          field_name: error.field,
          raw_value: error.value,
          error_message: error.error,
        })),
      );
    }

    const successRows = rows.length - invalidRows.size;

    await supabase
      .from("imports")
      .update({
        status: errors.length > 0 ? "failed" : "completed",
        success_rows: successRows,
        error_rows: errors.length,
        created_products: createdRows,
        updated_products: updatedRows,
      })
      .eq("id", importId)
      .eq("company_id", companyId);

    setResult({
      totalRows: rows.length,
      successRows,
      createdRows,
      updatedRows,
      errorRows: errors.length,
      errors,
    });
    setValidationErrors(errors);
    setStep(4);
    setIsBusy(false);
  }

  function prevStep() {
    setStep((current) => Math.max(current - 1, 0));
  }

  function finishImport() {
    setStep(0);
    setSelectedFile(null);
    setColumns([]);
    setRows([]);
    setMapping({});
    setValidationErrors([]);
    setResult(null);
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
            Импорт принимает .xlsx, .xls и .csv. Фото и видео в этом этапе не импортируются.
          </p>
        </CardContent>
      </Card>

      {pageError ? (
        <Card className="mb-6 border-red-100 bg-red-50">
          <CardContent className="p-5 text-sm text-red-700">{pageError}</CardContent>
        </Card>
      ) : null}

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
            <CardDescription>Выберите Excel или CSV файл с товарами.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
            <div
              className="rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-8 text-center"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void chooseFile(event.dataTransfer.files[0]);
              }}
            >
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-white text-primary shadow-soft">
                <UploadCloud className="size-6" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Перетащите Excel/CSV файл сюда</h3>
              <p className="mt-1 text-sm text-muted-foreground">Поддерживаются .xlsx, .xls и .csv</p>
              <Button className="mt-4" type="button" onClick={() => inputRef.current?.click()} disabled={isBusy}>
                {isBusy ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
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
            <CardDescription>Первые 10 строк файла и найденные колонки.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap gap-2">
              {columns.map((column) => (
                <Badge key={column} className="bg-blue-50 text-blue-700">
                  {column}
                </Badge>
              ))}
            </div>
            <div className="overflow-hidden rounded-lg border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse bg-white text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      {columns.map((column) => (
                        <th key={column} className="px-4 py-3 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 10).map((row, index) => (
                      <tr key={index} className="border-t">
                        {columns.map((column) => (
                          <td key={column} className="px-4 py-3">
                            {row[column]}
                          </td>
                        ))}
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
                  {columns.map((column) => {
                    const selectedField = systemFields.find((field) => field.value === mapping[column]);

                    return (
                      <tr key={column} className="border-t">
                        <td className="px-4 py-3 font-medium">{column}</td>
                        <td className="px-4 py-3">
                          <select
                            className={selectClass}
                            value={mapping[column] ?? ""}
                            onChange={(event) => {
                              const nextMapping = { ...mapping, [column]: event.target.value };
                              const nextCategoryColumn = findMappedColumn(nextMapping, "category");

                              setMapping(nextMapping);
                              setCategoryMapping(buildCategoryMapping(rows, nextCategoryColumn, categories));
                              setDefaultCategoryId("");
                            }}
                          >
                            {systemFields.map((field) => (
                              <option key={field.value} value={field.value}>
                                {field.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{selectedField?.type ?? "—"}</td>
                        <td className="px-4 py-3">
                          <Badge className={mapping[column] ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}>
                            {mapping[column] ? "Сопоставлено" : "Пропуск"}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-6 rounded-lg border bg-white">
              <div className="border-b p-4">
                <h3 className="text-sm font-semibold">Сопоставление категорий</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Категории из файла не создаются автоматически. Выберите существующую категорию в системе.
                </p>
              </div>
              {categoryColumn ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] border-collapse text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-medium">Категория из файла</th>
                        <th className="px-4 py-3 font-medium">Категория в системе</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fileCategories.map((categoryName) => (
                        <tr key={categoryName} className="border-t">
                          <td className="px-4 py-3 font-medium">{categoryName}</td>
                          <td className="px-4 py-3">
                            <select
                              className={selectClass}
                              value={categoryMapping[categoryName] ?? ""}
                              onChange={(event) =>
                                setCategoryMapping((current) => ({ ...current, [categoryName]: event.target.value }))
                              }
                            >
                              <option value="">Выберите категорию</option>
                              {categories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.name} ({category.code})
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-2 p-4">
                  <p className="text-sm text-muted-foreground">Категория для всех товаров</p>
                  <select
                    className={selectClass}
                    value={defaultCategoryId}
                    onChange={(event) => setDefaultCategoryId(event.target.value)}
                  >
                    <option value="">Выберите категорию</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name} ({category.code})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 4 — Проверка ошибок</CardTitle>
            <CardDescription>Ошибки, найденные перед импортом.</CardDescription>
          </CardHeader>
          <CardContent>
            {validationErrors.length === 0 ? (
              <div className="rounded-lg border bg-emerald-50 p-5 text-sm text-emerald-700">
                Ошибок не найдено. Можно запускать импорт.
              </div>
            ) : (
              <ErrorsTable errors={validationErrors} />
            )}
          </CardContent>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>Шаг 5 — Результат импорта</CardTitle>
            <CardDescription>Итоговые показатели импорта.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[
                ["Всего строк", result?.totalRows ?? 0],
                ["Успешно", result?.successRows ?? 0],
                ["С ошибками", result?.errorRows ?? 0],
                ["Создано", result?.createdRows ?? 0],
                ["Обновлено", result?.updatedRows ?? 0],
              ].map(([label, value]) => (
                <Card key={label}>
                  <CardContent className="p-5">
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <p className="mt-2 text-2xl font-semibold">{value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            {result?.errors.length ? <ErrorsTable errors={result.errors} /> : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={prevStep} disabled={step === 0 || isBusy}>
          <ArrowLeft />
          Назад
        </Button>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {step === 1 ? (
            <Button onClick={() => setStep(2)}>
              Продолжить
              <ArrowRight />
            </Button>
          ) : null}
          {step === 2 ? (
            <Button onClick={() => void runValidation()} disabled={isBusy}>
              {isBusy ? <Loader2 className="animate-spin" /> : <AlertTriangle />}
              Запустить проверку
            </Button>
          ) : null}
          {step === 3 ? (
            <Button onClick={() => void runImport()} disabled={isBusy || hasUnmappedCategories}>
              {isBusy ? <Loader2 className="animate-spin" /> : <Play />}
              Запустить импорт
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

function ErrorsTable({ errors }: { errors: ImportErrorItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse bg-white text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Строка</th>
              <th className="px-4 py-3 font-medium">Поле</th>
              <th className="px-4 py-3 font-medium">Значение</th>
              <th className="px-4 py-3 font-medium">Ошибка</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((item, index) => (
              <tr key={`${item.row}-${item.field}-${index}`} className="border-t">
                <td className="px-4 py-3">{item.row}</td>
                <td className="px-4 py-3 font-medium">{item.field}</td>
                <td className="px-4 py-3 text-muted-foreground">{item.value || "пусто"}</td>
                <td className="px-4 py-3 text-red-700">{item.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
