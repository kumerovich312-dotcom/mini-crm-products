import { Layers3, Plus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function CategoriesPage() {
  return (
    <>
      <PageHeader
        badge="Categories"
        title="Категории"
        description="Управление категориями и кодами для генерации артикула товара."
        action={
          <Button>
            <Plus />
            Добавить категорию
          </Button>
        }
      />
      <EmptyState
        icon={Layers3}
        title="Категории пока не подключены"
        description="Здесь появится таблица категорий с названием и кодом категории."
      />
    </>
  );
}
