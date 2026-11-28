// The whole extension surface in this PoC. Extensions only import types from
// here, so nothing from the host ends up in an extension bundle.

export interface Item {
  title: string;
  subtitle?: string;
  /** Enter opens this URL. */
  url?: string;
  /** Enter copies this text. Ignored when `url` is set. */
  copy?: string;
}

export interface SearchContext {
  /** Aborts when the user types again or the search times out. */
  signal: AbortSignal;
}

export interface Source {
  /** `stock 삼성` runs only the source with keyword `stock`, with query `삼성`. */
  keyword?: string;
  search(query: string, ctx: SearchContext): Item[] | Promise<Item[]>;
}

export interface QueryEvent {
  query: string;
}

export type QueryHandler = (
  event: QueryEvent,
) => { query: string } | void | Promise<{ query: string } | void>;

export interface ExtensionAPI {
  on(event: "query", handler: QueryHandler): void;
  registerSource(source: Source): void;
}
