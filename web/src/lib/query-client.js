import { QueryClient } from '@tanstack/react-query';

// Calm defaults: data stays fresh for 30s (no refetch storm when moving between pages),
// transient network/server errors retry with backoff, and real "no"s (4xx) fail fast.
export const queryClientInstance = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			refetchOnReconnect: true,
			staleTime: 30_000,
			retry: (count, error) => {
				const status = error?.status || error?.response?.status;
				if (status && status >= 400 && status < 500 && status !== 429) return false;
				return count < 2;
			},
			retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
		},
	},
});
