// Records every request and answers from a route table: "METHOD /path" → (url, body) => [status, json].
export interface Seen { origin: string; method: string; path: string; query: URLSearchParams; body: any; headers: Record<string, string> }
type Handler = (url: URL, body: any) => [number, unknown];
export function fakeApi(routes: Record<string, Handler>) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ origin: url.origin, method, path: url.pathname, query: url.searchParams, body, headers: init?.headers as Record<string, string> });
    const h = routes[`${method} ${url.pathname}`];
    const [status, json] = h ? h(url, body) : [404, { error: "no route" }];
    return new Response(JSON.stringify(json), { status });
  };
  return { fetchImpl, seen };
}
