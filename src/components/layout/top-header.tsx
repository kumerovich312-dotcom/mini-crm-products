"use client";

import { useRouter } from "next/navigation";
import { LogOut, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase/client";

export function TopHeader() {
  const router = useRouter();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-white/90 px-4 backdrop-blur md:px-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-muted-foreground">JWL Company</p>
        <h1 className="truncate text-lg font-semibold">Каталог товаров</h1>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative hidden w-72 md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Поиск товаров" />
        </div>
        <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
          <LogOut />
          Выйти
        </Button>
      </div>
    </header>
  );
}
