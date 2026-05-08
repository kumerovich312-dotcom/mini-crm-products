import { PencilLine } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function EditProductPage() {
  return (
    <>
      <PageHeader
        badge="Edit product"
        title="Редактирование товара"
        description="Страница для изменения карточки товара и настроек видимости в API."
      />
      <EmptyState
        icon={PencilLine}
        title="Редактор товара"
        description="Позже здесь появятся поля товара, медиа, пользовательские поля и keywords."
      />
    </>
  );
}
