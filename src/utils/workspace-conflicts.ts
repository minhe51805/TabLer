import type {
  WorkspaceBundle,
  WorkspaceBundleConnection,
  WorkspaceBundleDashboard,
  WorkspaceBundleERView,
  WorkspaceBundleQuery,
  WorkspaceEntityMetadata,
} from "./workspace-bundle";

export type WorkspaceConflictKind =
  | "connection"
  | "saved-query"
  | "dashboard"
  | "er-view";
export type WorkspaceConflictChoice = "local" | "remote" | "duplicate";
export type WorkspaceConflictEntity =
  | WorkspaceBundleConnection
  | WorkspaceBundleQuery
  | WorkspaceBundleDashboard
  | WorkspaceBundleERView;

export interface WorkspaceConflict {
  key: string;
  kind: WorkspaceConflictKind;
  entityId: string;
  base?: WorkspaceConflictEntity;
  local?: WorkspaceConflictEntity;
  remote?: WorkspaceConflictEntity;
  reason: "both-edited" | "delete-vs-edit" | "created-twice";
}

export interface WorkspaceMergePlan {
  merged: WorkspaceBundle;
  conflicts: WorkspaceConflict[];
}

type EntityBucket = {
  kind: WorkspaceConflictKind;
  field: "connections" | "queries" | "dashboards" | "erViews";
};

const BUCKETS: EntityBucket[] = [
  { kind: "connection", field: "connections" },
  { kind: "saved-query", field: "queries" },
  { kind: "dashboard", field: "dashboards" },
  { kind: "er-view", field: "erViews" },
];

function entitiesById<T extends WorkspaceEntityMetadata>(entities: T[] | undefined) {
  return new Map((entities ?? []).map((entity) => [entity.id, entity]));
}

function sameRevision(
  left: WorkspaceConflictEntity | undefined,
  right: WorkspaceConflictEntity | undefined,
) {
  return left?.revision === right?.revision && Boolean(left) === Boolean(right);
}

function mergeEntityBucket(
  bucket: EntityBucket,
  baseBundle: WorkspaceBundle | undefined,
  localBundle: WorkspaceBundle,
  remoteBundle: WorkspaceBundle,
) {
  const base = entitiesById(baseBundle?.[bucket.field] as WorkspaceConflictEntity[] | undefined);
  const local = entitiesById(localBundle[bucket.field] as WorkspaceConflictEntity[]);
  const remote = entitiesById(remoteBundle[bucket.field] as WorkspaceConflictEntity[]);
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const merged: WorkspaceConflictEntity[] = [];
  const conflicts: WorkspaceConflict[] = [];

  for (const id of ids) {
    const baseEntity = base.get(id);
    const localEntity = local.get(id);
    const remoteEntity = remote.get(id);
    if (sameRevision(localEntity, remoteEntity)) {
      if (localEntity) merged.push(localEntity);
      continue;
    }
    if (baseEntity && sameRevision(localEntity, baseEntity)) {
      if (remoteEntity) merged.push(remoteEntity);
      continue;
    }
    if (baseEntity && sameRevision(remoteEntity, baseEntity)) {
      if (localEntity) merged.push(localEntity);
      continue;
    }
    if (!baseEntity && !localEntity && remoteEntity) {
      merged.push(remoteEntity);
      continue;
    }
    if (!baseEntity && localEntity && !remoteEntity) {
      merged.push(localEntity);
      continue;
    }

    const reason = baseEntity
      ? !localEntity || !remoteEntity
        ? "delete-vs-edit"
        : "both-edited"
      : "created-twice";
    conflicts.push({
      key: `${bucket.kind}:${id}`,
      kind: bucket.kind,
      entityId: id,
      base: baseEntity,
      local: localEntity,
      remote: remoteEntity,
      reason,
    });
    if (localEntity) merged.push(localEntity);
  }

  return { merged, conflicts };
}

export function planWorkspaceMerge(
  local: WorkspaceBundle,
  remote: WorkspaceBundle,
  base?: WorkspaceBundle,
): WorkspaceMergePlan {
  const merged: WorkspaceBundle = {
    ...local,
    exportedAt: new Date().toISOString(),
    target: remote.target,
    layout: local.layout,
    connections: [],
    queries: [],
    dashboards: [],
    erViews: [],
  };
  const conflicts: WorkspaceConflict[] = [];
  for (const bucket of BUCKETS) {
    const result = mergeEntityBucket(bucket, base, local, remote);
    (merged[bucket.field] as WorkspaceConflictEntity[]) = result.merged;
    conflicts.push(...result.conflicts);
  }
  return { merged, conflicts };
}

function duplicateEntity(entity: WorkspaceConflictEntity, suffix: string): WorkspaceConflictEntity {
  return {
    ...entity,
    id: `${entity.id}-copy-${suffix.slice(0, 8)}`,
  };
}

export function resolveWorkspaceConflicts(
  plan: WorkspaceMergePlan,
  choices: Record<string, WorkspaceConflictChoice>,
): WorkspaceBundle {
  const resolved: WorkspaceBundle = {
    ...plan.merged,
    connections: [...plan.merged.connections],
    queries: [...plan.merged.queries],
    dashboards: [...plan.merged.dashboards],
    erViews: [...plan.merged.erViews],
  };

  for (const conflict of plan.conflicts) {
    const choice = choices[conflict.key];
    if (!choice) throw new Error(`Conflict "${conflict.key}" has not been resolved.`);
    if (choice === "duplicate" && conflict.kind === "connection") {
      throw new Error("Connection metadata cannot be duplicated during sync resolution.");
    }
    const bucket = BUCKETS.find((item) => item.kind === conflict.kind)!;
    const target = resolved[bucket.field] as WorkspaceConflictEntity[];
    const withoutConflict = target.filter((entity) => entity.id !== conflict.entityId);
    const selected = choice === "remote" ? conflict.remote : conflict.local;
    if (selected) withoutConflict.push(selected);
    if (choice === "duplicate") {
      if (conflict.local && !selected) withoutConflict.push(conflict.local);
      if (conflict.remote) {
        withoutConflict.push(duplicateEntity(conflict.remote, conflict.remote.revision));
      }
    }
    (resolved[bucket.field] as WorkspaceConflictEntity[]) = withoutConflict;
  }

  resolved.exportedAt = new Date().toISOString();
  return resolved;
}
