import { NextResponse } from "next/server";

import { DEFAULT_COMPANY_ID } from "@/lib/constants";
import { logAppError } from "@/lib/errors";
import { supabaseServer } from "@/lib/supabase/server";
import type { Category, CustomField, Product, ProductCustomValue, ProductMedia } from "@/types/database";

function getMediaType(media: ProductMedia) {
  return media.media_type ?? media.type ?? "photo";
}

function getMediaUrl(media: ProductMedia) {
  return media.processed_url ?? media.optimized_url ?? media.original_url;
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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const includeDrafts = searchParams.get("include_drafts") === "true";

  const [productResult, categoriesResult, mediaResult, customFieldsResult, customValuesResult] = await Promise.all([
    supabaseServer
      .from("products")
      .select("*")
      .eq("company_id", DEFAULT_COMPANY_ID)
      .eq("id", id)
      .eq("is_visible_in_api", true)
      .maybeSingle(),
    supabaseServer.from("categories").select("*").eq("company_id", DEFAULT_COMPANY_ID),
    supabaseServer
      .from("product_media")
      .select("*")
      .eq("company_id", DEFAULT_COMPANY_ID)
      .eq("product_id", id)
      .order("sort_order", { ascending: true }),
    supabaseServer.from("custom_fields").select("*").eq("company_id", DEFAULT_COMPANY_ID).eq("is_visible_in_api", true),
    supabaseServer.from("product_custom_values").select("*").eq("company_id", DEFAULT_COMPANY_ID).eq("product_id", id),
  ]);

  const error =
    productResult.error ??
    categoriesResult.error ??
    mediaResult.error ??
    customFieldsResult.error ??
    customValuesResult.error;

  if (error) {
    logAppError("Public product API error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!productResult.data) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const product = productResult.data as Product;

  if (product.status !== "active" && !(includeDrafts && product.status === "draft")) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const categories = ((categoriesResult.data ?? []) as Category[]) ?? [];
  const category = product.category_id ? categories.find((item) => item.id === product.category_id) ?? null : null;
  const media = (((mediaResult.data ?? []) as ProductMedia[]) ?? []).map((item) => ({
    type: getMediaType(item),
    url: getMediaUrl(item),
    thumbnail_url: item.thumbnail_url,
  }));
  const customFields = ((customFieldsResult.data ?? []) as CustomField[]) ?? [];
  const customFieldById = new Map(customFields.map((field) => [field.id, field]));
  const customValues = (((customValuesResult.data ?? []) as ProductCustomValue[]) ?? []).reduce<
    Record<string, string | number | boolean | null>
  >((acc, value) => {
    const field = customFieldById.get(value.custom_field_id);

    if (field) {
      acc[field.key] = getCustomFieldValue(field, value);
    }

    return acc;
  }, {});

  return NextResponse.json({
    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: category
        ? {
            id: category.id,
            name: category.name,
            category_code: category.code,
          }
        : null,
      price: product.price,
      stock: product.stock,
      status: product.status,
      description: product.description,
      keywords: product.keywords,
      custom_fields: customValues,
      media,
    },
  });
}
