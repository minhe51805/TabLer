import { describe, it, expect, beforeEach } from "vitest";
import {
  assignFavoriteToFolder,
  createFavoriteFolder,
  deleteFavoriteFolder,
  getCollapsedFavoriteFolderIds,
  getFavoriteFolderAssignments,
  getFavoriteFolders,
  removeFavoriteAssignment,
  renameFavoriteFolder,
  toggleFavoriteFolderCollapse,
} from "./favorite-folder-store";

describe("favorite-folder-store", () => {
  beforeEach(() => window.localStorage.clear());

  it("creates, assigns, renames folders; assignments persist", () => {
    const folder = createFavoriteFolder("Reports");
    expect(getFavoriteFolders()).toHaveLength(1);

    assignFavoriteToFolder("f1", folder.id);
    assignFavoriteToFolder("f2", folder.id);
    expect(getFavoriteFolderAssignments()).toEqual({
      f1: folder.id,
      f2: folder.id,
    });

    renameFavoriteFolder(folder.id, "Prod reports");
    expect(getFavoriteFolders()[0].name).toBe("Prod reports");

    assignFavoriteToFolder("f1", null);
    expect(getFavoriteFolderAssignments()).toEqual({ f2: folder.id });
  });

  it("deleting a folder clears its assignments and collapse state", () => {
    const folder = createFavoriteFolder("A");
    assignFavoriteToFolder("f1", folder.id);
    toggleFavoriteFolderCollapse(folder.id);

    deleteFavoriteFolder(folder.id);
    expect(getFavoriteFolders()).toHaveLength(0);
    expect(getFavoriteFolderAssignments()).toEqual({});
    expect(getCollapsedFavoriteFolderIds().has(folder.id)).toBe(false);
  });

  it("removeFavoriteAssignment drops a single mapping", () => {
    const folder = createFavoriteFolder("A");
    assignFavoriteToFolder("f1", folder.id);
    removeFavoriteAssignment("f1");
    expect(getFavoriteFolderAssignments()).toEqual({});
  });

  it("collapse state toggles and persists", () => {
    expect(toggleFavoriteFolderCollapse("x")).toBe(true);
    expect(getCollapsedFavoriteFolderIds().has("x")).toBe(true);
    expect(toggleFavoriteFolderCollapse("x")).toBe(false);
    expect(getCollapsedFavoriteFolderIds().has("x")).toBe(false);
  });
});
