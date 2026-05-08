import { ProductCardForm } from "@/components/products/product-card-form";
import { PageHeader } from "@/components/page-header";

export default function NewProductPage() {
  return (
    <>
      <PageHeader
        badge="Новый товар"
        title="Добавить товар"
        description="Создание карточки товара с фото, видео, ценой, остатком, дополнительными полями и keywords."
      />
      <ProductCardForm mode="new" />
    </>
  );
}
