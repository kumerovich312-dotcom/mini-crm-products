import { NextResponse } from "next/server";

import { DEFAULT_COMPANY_ID } from "@/lib/constants";
import { logAppError } from "@/lib/errors";
import { supabaseServer } from "@/lib/supabase/server";
import type { Category, CustomField, Product, ProductCustomValue, ProductMedia } from "@/types/database";

type PublicProduct = {
  id: string;
  sku: string;
  name: string;
  category: {
    id: string;
    name: string;
    code: string;
  } | null;
  price: number;
  stock: number;
  status: string;
  description: string | null;
  keywords: string[];
  custom_fields: Record<string, string | number | boolean | null>;
  media: Array<{
    type: string;
    url: string;
    thumbnail_url: string | null;
  }>;
};

function parseLimit(value: string | null) {
  const limit = Number(value ?? 20);

  if (!Number.isFinite(limit) || limit <= 0) {
    return 20;
  }

  return Math.min(Math.floor(limit), 50);
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function getMediaType(media: ProductMedia) {
  return media.media_type;
}

function getMediaUrl(media: ProductMedia) {
  return media.processed_url ?? media.original_url;
}

function getCustomFieldValue(field: CustomField, value: ProductCustomValue) {
  if (field.field_type === "number") {
    return value.value_number;
  }

  if (field.field_type === "boolean") {
    return value.value_boolean;
  }

  return value.value_text;
}

function buildPublicProducts(
  products: Product[],
  categories: Category[],
  media: ProductMedia[],
  customFields: CustomField[],
  customValues: ProductCustomValue[],
) {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const customFieldById = new Map(customFields.map((field) => [field.id, field]));

  return products.map<PublicProduct>((product) => {
    const category = product.category_id ? categoryById.get(product.category_id) ?? null : null;
    const productMedia = media
      .filter((item) => item.product_id === product.id)
      .map((item) => ({
        type: getMediaType(item),
        url: getMediaUrl(item),
        thumbnail_url: item.thumbnail_url,
      }));
    const productCustomFields = customValues
      .filter((value) => value.product_id === product.id)
      .reduce<Record<string, string | number | boolean | null>>((acc, value) => {
        const field = customFieldById.get(value.custom_field_id);

        if (field) {
          acc[field.key] = getCustomFieldValue(field, value);
        }

        return acc;
      }, {});

    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
          category: category
            ? {
                id: category.id,
                name: category.name,
                code: category.code,
              }
            : null,
      price: product.price,
      stock: product.stock,
      status: product.status,
      description: product.description,
      keywords: product.keywords,
      custom_fields: productCustomFields,
      media: productMedia,
    };
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = normalize(searchParams.get("query") ?? "");
  const sku = normalize(searchParams.get("sku") ?? "");
  const category = normalize(searchParams.get("category") ?? "");
  const categoryId = searchParams.get("category_id")?.trim() ?? "";
  const limit = parseLimit(searchParams.get("limit"));

  const [productsResult, categoriesResult, mediaResult, customFieldsResult, customValuesResult] = await Promise.all([
    supabaseServer
      .from("products")
      .select("*")
      .eq("company_id", DEFAULT_COMPANY_ID)
      .eq("status", "active")
      .eq("is_visible_in_api", true)
      .gt("stock", 0)
      .order("updated_at", { ascending: false }),
    supabaseServer.from("categories").select("*").eq("company_id", DEFAULT_COMPANY_ID),
    supabaseServer.from("product_media").select("*").eq("company_id", DEFAULT_COMPANY_ID).order("sort_order", { ascending: true }),
    supabaseServer.from("custom_fields").select("*").eq("company_id", DEFAULT_COMPANY_ID).eq("is_visible_in_api", true),
    supabaseServer.from("product_custom_values").select("*").eq("company_id", DEFAULT_COMPANY_ID),
  ]);

  const error =
    productsResult.error ??
    categoriesResult.error ??
    mediaResult.error ??
    customFieldsResult.error ??
    customValuesResult.error;

  if (error) {
    logAppError("Public products API error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const categories = ((categoriesResult.data ?? []) as Category[]) ?? [];
  const matchingCategoryIds = category
    ? categories
        .filter((item) => normalize(item.name).includes(category) || normalize(item.code).includes(category))
        .map((item) => item.id)
    : [];

  const products = (((productsResult.data ?? []) as Product[]) ?? [])
    .filter((product) => !sku || normalize(product.sku) === sku)
    .filter((product) => !categoryId || product.category_id === categoryId)
    .filter((product) => !category || (product.category_id ? matchingCategoryIds.includes(product.category_id) : false))
    .filter((product) => {
      if (!query) {
        return true;
      }

      const haystack = [
        product.name,
        product.sku,
        product.description ?? "",
        ...product.keywords,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    })
    .slice(0, limit);

  return NextResponse.json({
    products: buildPublicProducts(
      products,
      categories,
      ((mediaResult.data ?? []) as ProductMedia[]) ?? [],
      ((customFieldsResult.data ?? []) as CustomField[]) ?? [],
      ((customValuesResult.data ?? []) as ProductCustomValue[]) ?? [],
    ),
  });
}
