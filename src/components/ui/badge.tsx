import * as React from "react";

import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border border-transparent bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}
