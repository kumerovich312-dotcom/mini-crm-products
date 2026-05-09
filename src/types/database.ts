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

export interface ProductCustomValue {
  id: string;
  company_id: string;
  product_id: string;
  custom_field_id: string;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: Company;
        Insert: Omit<Company, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<Company, "id">>;
        Relationships: [];
      };
      categories: {
        Row: Category;
        Insert: Omit<Category, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<Category, "id" | "company_id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      products: {
        Row: Product;
        Insert: Omit<Product, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<Product, "id" | "company_id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      product_media: {
        Row: ProductMedia;
        Insert: Omit<ProductMedia, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ProductMedia, "id" | "company_id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      custom_fields: {
        Row: CustomField;
        Insert: Omit<CustomField, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<CustomField, "id" | "company_id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      product_custom_values: {
        Row: ProductCustomValue;
        Insert: Omit<ProductCustomValue, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ProductCustomValue, "id" | "company_id" | "product_id" | "custom_field_id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
