import { QueryClient } from '@tanstack/react-query';

/**
 * The data of the console, shared by every page: what one page read is there for the next one,
 * fresh for 30 seconds, read again when the window comes back or when the server says it changed
 * (live.ts). A refused request (4xx: rights, missing module) is not retried.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: true,
      retry: (failures, err) => {
        const status = (err as { status?: number })?.status ?? 0;
        return status >= 400 && status < 500 ? false : failures < 2;
      },
    },
  },
});

/** Keys of the shared data: one place, so a live event knows what to refresh. */
export const keys = {
  unread: ['notifications', 'count'] as const,
  notifications: ['notifications'] as const,
  cpeHealth: ['cpe-health'] as const,
  network: ['network', 'status'] as const,
  jobs: (q: string) => ['jobs', q] as const,
  customers: (q: string) => ['customers', q] as const,
  advisor: ['advisor'] as const,
  outages: ['outages'] as const,
};
