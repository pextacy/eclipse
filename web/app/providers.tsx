"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "../src/wagmi";

/**
 * Client-side providers for the Eclipse app: wagmi (wallet + Coston2 contract
 * calls) and react-query. Marked "use client" because wagmi relies on browser
 * APIs and React context — everything below it renders on the client.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
