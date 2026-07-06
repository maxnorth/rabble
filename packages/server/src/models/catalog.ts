import type { CatalogModel } from "@rabblehq/core";

/**
 * The curated built-in model catalog. Built-in models authenticate through a
 * single org-level provider key (Admin > Models) or the server's environment,
 * so enabling one never asks for credentials.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  {
    catalogId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    protocol: "anthropic",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    description: "Balanced intelligence and speed — the default choice.",
    priceInputPerMtok: 3,
    priceOutputPerMtok: 15,
  },
  {
    catalogId: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    protocol: "anthropic",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    description: "Highest capability for complex, high-stakes agent work.",
    priceInputPerMtok: 15,
    priceOutputPerMtok: 75,
  },
  {
    catalogId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    protocol: "anthropic",
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    description: "Fast and inexpensive for high-volume, simple tasks.",
    priceInputPerMtok: 1,
    priceOutputPerMtok: 5,
  },
];

export function getCatalogModel(catalogId: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.catalogId === catalogId);
}
