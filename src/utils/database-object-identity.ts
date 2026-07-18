export interface DatabaseObjectIdentity {
  connectionId: string;
  database: string | null;
  schema: string | null;
  object: string;
}

export function buildDatabaseObjectKey(identity: DatabaseObjectIdentity): string {
  return JSON.stringify([
    identity.connectionId,
    identity.database ?? "",
    identity.schema ?? "",
    identity.object,
  ]);
}

export function buildQualifiedObjectIdentity(
  connectionId: string,
  qualifiedObject: string,
  database?: string,
): DatabaseObjectIdentity {
  const separator = qualifiedObject.indexOf(".");
  return {
    connectionId,
    database: database || null,
    schema: separator > 0 ? qualifiedObject.slice(0, separator) : null,
    object: separator > 0 ? qualifiedObject.slice(separator + 1) : qualifiedObject,
  };
}
