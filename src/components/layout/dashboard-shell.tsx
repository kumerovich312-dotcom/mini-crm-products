import { Sidebar } from "@/components/layout/sidebar";
import { TopHeader } from "@/components/layout/top-header";

export function DashboardShell({ children }: { children: React.ReactNode }) {
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
