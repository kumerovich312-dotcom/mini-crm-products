"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  Braces,
  FileSpreadsheet,
  Home,
  KeyRound,
  Layers3,
  PlusCircle,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Обзор", icon: Home, active: ["/dashboard"] },
  {
    href: "/dashboard/products",
    label: "Товары",
    icon: Boxes,
    active: ["/dashboard/products"],
    activePrefix: "/dashboard/products/",
    exclude: ["/dashboard/products/new"],
  },
  { href: "/dashboard/products/new", label: "Новый товар", icon: PlusCircle, active: ["/dashboard/products/new"] },
  { href: "/dashboard/categories", label: "Категории", icon: Layers3, active: ["/dashboard/categories"] },
  { href: "/dashboard/custom-fields", label: "Поля", icon: Braces, active: ["/dashboard/custom-fields"] },
  { href: "/dashboard/import", label: "Импорт", icon: FileSpreadsheet, active: ["/dashboard/import"] },
  { href: "/dashboard/api", label: "API для ИИ", icon: KeyRound, active: ["/dashboard/api"] },
  { href: "/dashboard/settings", label: "Настройки", icon: Settings, active: ["/dashboard/settings"] },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-72 shrink-0 border-r bg-white lg:block">
      <div className="flex h-16 items-center gap-3 border-b px-6">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <BarChart3 className="size-5" />
        </div>
        <div>
          <p className="text-sm font-semibold">Мини-CRM</p>
          <p className="text-xs text-muted-foreground">Товарная админка</p>
        </div>
      </div>
      <nav className="space-y-1 p-4">
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
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                isActive && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
