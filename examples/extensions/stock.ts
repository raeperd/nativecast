// Copy to ~/.nativecast/extensions/. Try `stock 삼성`, or `삼전` through the query hook.
import type { ExtensionAPI } from "../../host/src/api";

export default function (app: ExtensionAPI) {
  app.on("query", (event) => (event.query === "삼전" ? { query: "삼성전자" } : undefined));
  app.registerSource({
    keyword: "stock",
    async search(query, ctx) {
      const url = `https://ac.stock.naver.com/ac?target=stock&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, { signal: ctx.signal });
      const { items } = (await response.json()) as {
        items: { code: string; name: string; typeName: string; url: string }[];
      };
      return items.map((item) => ({
        title: item.name,
        subtitle: `${item.code} · ${item.typeName}`,
        url: `https://m.stock.naver.com${item.url}`,
      }));
    },
  });
}
