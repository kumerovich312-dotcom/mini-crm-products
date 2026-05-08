import { Braces, Plus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function CustomFieldsPage() {
  return (
    <>
      <PageHeader
        badge="Custom fields"
        title="Пользовательские поля"
        description="Настройка дополнительных полей товара: текст, число, список, да/нет."
        action={
          <Button>
            <Plus />
            Добавить поле
          </Button>
        }
      />
      <EmptyState
        icon={Braces}
        title="Поля будут добавлены позже"
        description="Каркас готов для будущего конструктора пользовательских полей."
      />
    </>
  );
}
