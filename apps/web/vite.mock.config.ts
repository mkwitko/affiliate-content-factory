import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";

/** Screenshot-only API mock: serves fixtures from ./mock so the desk renders without a database. */
const mockApi = (): Plugin => ({
  name: "mock-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      const send = (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (url.startsWith("/v1/auth/session"))
        return send({ authenticated: true, user: { id: "u1", email: "operator@example.com" } });
      if (url.startsWith("/v1/me/workspaces"))
        return send({ workspaces: [{ id: "ws1", name: "Example Shop", role: "operator" }] });
      if (/\/panel(\?|$)/.test(url))
        return send(
          JSON.parse(readFileSync(new URL("./mock/panel.json", import.meta.url), "utf8")),
        );
      if (url.startsWith("/v1/public/storefronts/"))
        return send(
          JSON.parse(readFileSync(new URL("./mock/storefront.json", import.meta.url), "utf8")),
        );
      if (url.includes("/provider-connections")) return send({ connections: [] });
      if (url.startsWith("/v1/")) return send({ error: { code: "MOCK", message: "mock" } }, 404);
      next();
    });
  },
});

export default defineConfig({ plugins: [tailwindcss(), mockApi()] });
