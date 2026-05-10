"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Sidebar } from "@/components/layout/sidebar";
import { TopHeader } from "@/components/layout/top-header";
import { logAppError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (error || !user) {
        if (error) {
          logAppError("Dashboard auth error", error);
        }

        router.replace("/login");
        router.refresh();
        return;
      }

      setIsCheckingAuth(false);
    }

    void checkAuth();
  }, [router]);

  if (isCheckingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-muted-foreground">
        <span className="inline-flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Загрузка
        </span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="min-w-0 flex-1">
          <TopHeader />
          <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
