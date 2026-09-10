/**
 * Builder definition persistence (Group-2 Feature 5, Phase 3).
 *
 * Query-builder models are saved locally (localStorage, same tier as the
 * column layout) so a partially built query survives restarts and can be
 * reloaded per connection. Backend sync can replace this later without
 * changing the model shape.
 */

import type { QueryBuilderModel } from "./query-builder";

export interface BuilderDefinition {
  id: string;
  name: string;
  model: QueryBuilderModel;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = "tabler.builder-definitions.v1";

function loadAll(): BuilderDefinition[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as BuilderDefinition[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistAll(definitions: BuilderDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(definitions));
  } catch {
    // Storage exhaustion must not break the builder.
  }
}

export function listBuilderDefinitions(): BuilderDefinition[] {
  return loadAll().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function saveBuilderDefinition(name: string, model: QueryBuilderModel): BuilderDefinition {
  const definitions = loadAll();
  const existing = definitions.find((definition) => definition.name === name);
  const now = new Date().toISOString();
  if (existing) {
    existing.model = model;
    existing.updatedAt = now;
    persistAll(definitions);
    return existing;
  }
  const created: BuilderDefinition = {
    id: `bd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    model,
    createdAt: now,
    updatedAt: now,
  };
  definitions.push(created);
  persistAll(definitions);
  return created;
}

export function deleteBuilderDefinition(id: string): void {
  persistAll(loadAll().filter((definition) => definition.id !== id));
}
