import { ImagePlus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function NewProductPage() {
  return (
    <>
      <PageHeader
        badge="New product"
        title="Новый товар"
        description="Здесь будет форма товара: медиа, название, SKU, категория, цена, остаток, описание, поля и keywords."
      />
      <EmptyState
        icon={ImagePlus}
        title="Форма товара будет на следующем этапе"
        description="Сейчас подготовлен маршрут и место для будущей карточки товара."
      />
    </>
  );
}
