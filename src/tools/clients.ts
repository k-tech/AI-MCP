import { z } from "zod";
import { defineTool } from "./registry.js";
import { rowsOf } from "../http.js";

export interface ClientRow { id: number; name: string; status?: string; for_test?: boolean; mmp_track_party?: string; created_at?: string }

export const getClients = defineTool({
  name: "get_clients", title: "查询客户", stage: 1, write: false,
  description: "List FeedMob clients (id, name, status, MMP, for_test). Optional client_name filter, e.g. Uber matches Uber, Uber Eats, Uber Affiliate.",
  schema: { client_name: z.string().trim().min(1).optional().describe("Client name to search for (optional)") },
  async run({ client_name }, { api }) {
    const rows = rowsOf<ClientRow>(await api.get("/ai/api/clients", { client_name }));
    return { summary: `找到 ${rows.length} 个客户${client_name ? `（匹配 “${client_name}”）` : ""}`, data: rows };
  },
});
