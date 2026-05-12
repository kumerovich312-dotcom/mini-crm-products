"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, Search, X } from "lucide-react";

import { navItems } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export function TopHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [companyName, setCompanyName] = useState("Компания");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    async function loadCompanyName() {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        logAppError("Top header auth error", userError);
        return;
      }

      if (!user) {
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("company_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profileError) {
        logAppError("Top header profile error", profileError);
        return;
      }

      if (!profile?.company_id) {
        return;
      }

      const { data: company, error: companyError } = await supabase
        .from("companies")
        .select("name")
        .eq("id", profile.company_id)
        .maybeSingle();

      if (companyError) {
        logAppError("Top header company error", companyError);
        return;
      }

      if (company?.name) {
        setCompanyName(company.name);
      }
    }

    void loadCompanyName();
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur">
      <div className="flex h-16 items-center justify-between px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            aria-label={isMobileMenuOpen ? "Закрыть меню" : "Открыть меню"}
            className="lg:hidden"
            size="icon"
            type="button"
            variant="outline"
            onClick={() => setIsMobileMenuOpen((current) => !current)}
          >
            {isMobileMenuOpen ? <X /> : <Menu />}
          </Button>
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">{companyName}</p>
            <h1 className="truncate text-lg font-semibold">Каталог товаров</h1>
          </div>
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
      </div>
      {isMobileMenuOpen ? (
        <nav className="border-t bg-white px-3 py-3 shadow-sm lg:hidden">
          <div className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isExcluded = item.exclude?.some((path) => pathname === path);
              const isActive =
                !isExcluded &&
                (item.active.includes(pathname) ||
                  (item.activePrefix ? pathname.startsWith(item.activePrefix) : false));

              return (
                <Link
                  key={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    isActive && "bg-accent text-accent-foreground",
                  )}
                  href={item.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      ) : null}
    </header>
  );
}
