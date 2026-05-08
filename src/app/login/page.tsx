import { BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BarChart3 className="size-6" />
          </div>
          <div>
            <CardTitle className="text-xl">Вход в Мини-CRM</CardTitle>
            <CardDescription>Пока используется статичная форма без подключения авторизации.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input placeholder="Email" type="email" />
          <Input placeholder="Пароль" type="password" />
          <Button className="w-full">Войти</Button>
        </CardContent>
      </Card>
    </main>
  );
}
