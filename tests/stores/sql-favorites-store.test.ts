import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import {
  assignFavoriteToFolder,
  getFavoriteFolderAssignments,
} from "@/stores/favorite-folder-store";
import { useSqlFavoritesStore } from "@/stores/sql-favorites-store";
import type { SqlFavorite } from "@/types/query-history";

const favorite = (overrides: Partial<SqlFavorite> = {}): SqlFavorite => ({
  id: "fav-1",
  name: "Top users",
  sql: "SELECT * FROM users",
  tags: [],
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  ...overrides,
});

beforeEach(() => {
  invokeMutationMock.mockReset();
  window.localStorage.clear();
  useSqlFavoritesStore.setState({ favorites: [], isLoading: false, isSaving: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sqlFavoritesStore.saveFavorite", () => {
  it("prepends a newly saved favorite", async () => {
    useSqlFavoritesStore.setState({ favorites: [favorite({ id: "old" })] });
    invokeMutationMock.mockResolvedValue(favorite({ id: "new" }));

    const saved = await useSqlFavoritesStore.getState().saveFavorite({
      name: "New",
      sql: "SELECT 1",
    });

    expect(saved.id).toBe("new");
    expect(useSqlFavoritesStore.getState().favorites.map((f) => f.id)).toEqual(["new", "old"]);
    expect(useSqlFavoritesStore.getState().isSaving).toBe(false);
    expect(invokeMutationMock).toHaveBeenCalledWith("save_sql_favorite", {
      id: null,
      name: "New",
      description: null,
      sql: "SELECT 1",
      tags: null,
      connectionId: null,
      database: null,
    });
  });

  it("updates in place when the backend returns an existing id", async () => {
    useSqlFavoritesStore.setState({
      favorites: [favorite({ id: "a" }), favorite({ id: "b", name: "B" })],
    });
    invokeMutationMock.mockResolvedValue(favorite({ id: "b", name: "B edited" }));

    await useSqlFavoritesStore.getState().saveFavorite({
      id: "b",
      name: "B edited",
      sql: "SELECT 2",
    });

    const favorites = useSqlFavoritesStore.getState().favorites;
    expect(favorites.map((f) => f.id)).toEqual(["a", "b"]);
    expect(favorites[1]).toMatchObject({ name: "B edited" });
  });

  it("rethrows a backend failure and clears isSaving", async () => {
    invokeMutationMock.mockRejectedValue(new Error("disk full"));

    await expect(
      useSqlFavoritesStore.getState().saveFavorite({ name: "X", sql: "SELECT 1" }),
    ).rejects.toThrow("disk full");

    expect(useSqlFavoritesStore.getState().isSaving).toBe(false);
  });
});

describe("sqlFavoritesStore.deleteFavorite", () => {
  it("removes the entry and drops its folder assignment", async () => {
    useSqlFavoritesStore.setState({
      favorites: [favorite({ id: "fav-1" }), favorite({ id: "fav-2" })],
    });
    assignFavoriteToFolder("fav-1", "folder-7");
    invokeMutationMock.mockResolvedValue(undefined);

    await useSqlFavoritesStore.getState().deleteFavorite("fav-1");

    expect(useSqlFavoritesStore.getState().favorites.map((f) => f.id)).toEqual(["fav-2"]);
    // The stale mapping must not survive: a recreated favorite with the same
    // id would otherwise reattach to the deleted folder silently.
    expect(getFavoriteFolderAssignments()).not.toHaveProperty("fav-1");
  });

  it("keeps the favorite and rethrows when the backend delete fails", async () => {
    useSqlFavoritesStore.setState({ favorites: [favorite({ id: "fav-1" })] });
    invokeMutationMock.mockRejectedValue(new Error("locked"));

    await expect(useSqlFavoritesStore.getState().deleteFavorite("fav-1")).rejects.toThrow("locked");

    expect(useSqlFavoritesStore.getState().favorites).toHaveLength(1);
  });
});
