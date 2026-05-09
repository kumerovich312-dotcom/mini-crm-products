"use client";

import { useParams } from "next/navigation";

import { ProductCardForm } from "@/components/products/product-card-form";
import { PageHeader } from "@/components/page-header";

export default function EditProductPage() {
  const params = useParams<{ id: string }>();

  return (
    <>
      <PageHeader
        badge="Редактирование"
        title="Редактировать товар"
        description="Изменение карточки товара, медиа, пользовательских полей и настроек видимости в API."
      />
      <ProductCardForm mode="edit" productId={params.id} />
    </>
  );
}
