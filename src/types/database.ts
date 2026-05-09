export type ProductStatus = "active" | "hidden" | "out_of_stock" | "draft";
export type MediaType = "photo" | "video";
export type MediaStatus = "uploaded" | "processing" | "ready" | "failed";
export type CustomFieldType = "text" | "number" | "select" | "boolean";

export interface Company {
  id: string;
  name: string;
  slug: string;
  sku_prefix: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  company_id: string;
  name: string;
  code: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  company_id: string;
  category_id: string | null;
  name: string;
  sku: string;
  price: number;
  stock: number;
  status: ProductStatus;
  description: string | null;
  keywords: string[];
  api_visible: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductMedia {
  id: string;
  company_id: string;
  product_id: string;
  media_type: MediaType;
  original_url: string;
  processed_url: string | null;
  thumbnail_url: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  status: MediaStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CustomField {
  id: string;
  company_id: string;
  name: string;
  key: string;
  field_type: CustomFieldType;
  unit: string | null;
  options: unknown;
  is_required: boolean;
  api_visible: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: Company;
      };
      categories: {
        Row: Category;
      };
      products: {
        Row: Product;
      };
      product_media: {
        Row: ProductMedia;
      };
      custom_fields: {
        Row: CustomField;
      };
    };
  };
}
