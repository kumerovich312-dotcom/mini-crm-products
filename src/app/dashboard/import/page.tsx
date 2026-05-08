import { Upload } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function ImportPage() {
  return (
    <>
      <PageHeader
        badge="Import"
        title="Импорт Excel/CSV"
        description="Загрузка файла, предпросмотр строк и импорт товаров в каталог."
        action={
          <Button>
            <Upload />
            Загрузить файл
          </Button>
        }
      />
      <EmptyState
        icon={Upload}
        title="Импорт пока в режиме заглушки"
        description="На следующем этапе здесь появятся uploader и таблица предпросмотра."
      />
    </>
  );
}
