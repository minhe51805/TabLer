import { describe, expect, it } from "vitest";
import type { ColumnDetail } from "@/types/database";
import { generateCode, goImports, normalizeType, toPascalCase } from "@/utils/schema-codegen";

function col(name: string, dataType: string, opts: Partial<ColumnDetail> = {}): ColumnDetail {
  return {
    name,
    data_type: dataType,
    is_nullable: false,
    is_primary_key: false,
    ...opts,
  };
}

const USERS: ColumnDetail[] = [
  col("id", "bigint", { is_primary_key: true }),
  col("email", "varchar", { comment: "login address" }),
  col("display_name", "varchar", { is_nullable: true }),
  col("balance", "numeric"),
  col("is_active", "boolean"),
  col("created_at", "timestamptz"),
  col("settings", "jsonb", { is_nullable: true }),
  col("avatar", "bytea", { is_nullable: true }),
];

describe("normalizeType", () => {
  it.each([
    ["integer", "int"],
    ["bigint", "bigint"],
    ["numeric", "decimal"],
    ["double precision", "float"],
    ["boolean", "bool"],
    ["timestamptz", "datetime"],
    ["uuid", "uuid"],
    ["jsonb", "json"],
    ["bytea", "binary"],
    ["varchar(255)", "text"],
    ["citext", "text"],
    ["weird_custom_type", "text"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeType(input)).toBe(expected);
  });
});

describe("toPascalCase", () => {
  it("converts snake_case table names", () => {
    expect(toPascalCase("order_items")).toBe("OrderItems");
  });
  it("handles empty input", () => {
    expect(toPascalCase("")).toBe("Generated");
  });
});

describe("generateCode — typescript", () => {
  const { code, typeName, fieldCount } = generateCode(USERS, "users", "typescript");

  it("emits a compilable interface", () => {
    expect(typeName).toBe("Users");
    expect(fieldCount).toBe(8);
    expect(code).toContain("export interface Users {");
    expect(code).toContain("id: bigint; // primary key");
    expect(code).toContain("display_name: string | null;");
    expect(code).toContain("balance: string;");
    expect(code).toContain("is_active: boolean;");
    expect(code).toContain("settings: unknown | null;");
    expect(code).toContain("avatar: Uint8Array | null;");
    expect(code).toContain("/** login address */");
  });

  it("quotes invalid identifiers", () => {
    const { code } = generateCode([col("order-id", "int")], "t", "typescript");
    expect(code).toContain('"order-id": number;');
  });
});

describe("generateCode — zod", () => {
  const { code } = generateCode(USERS, "users", "zod");

  it("emits schema plus inferred type", () => {
    expect(code).toContain("export const usersSchema = z.object({");
    expect(code).toContain("id: z.bigint(), // primary key");
    expect(code).toContain("display_name: z.string().nullable(),");
    expect(code).toContain("created_at: z.string().datetime(),");
    expect(code).toContain("settings: z.unknown().nullable(),");
    expect(code).toContain("export type Users = z.infer<typeof usersSchema>;");
  });
});

describe("generateCode — rust", () => {
  const { code } = generateCode(USERS, "users", "rust");

  it("emits a serde struct", () => {
    expect(code).toContain("pub struct Users {");
    expect(code).toContain("pub id: i64,");
    expect(code).toContain("pub display_name: Option<String>,");
    expect(code).toContain("pub settings: Option<serde_json::Value>,");
    expect(code).toContain("pub avatar: Option<Vec<u8>>,");
  });

  it("renames non-snake columns and escapes keywords", () => {
    const { code } = generateCode([col("orderId", "int"), col("type", "text")], "t", "rust");
    expect(code).toContain('#[serde(rename = "orderId")]');
    expect(code).toContain("pub r#type: String,");
  });
});

describe("generateCode — go", () => {
  const { code } = generateCode(USERS, "users", "go");

  it("emits a struct with json tags and imports", () => {
    expect(code).toContain('"time"');
    expect(code).toContain('"encoding/json"');
    expect(code).toContain("type Users struct {");
    expect(code).toContain('Id int64 `json:"id"` // primary key');
    expect(code).toContain('DisplayName *string `json:"display_name"`');
    expect(code).toContain('Settings json.RawMessage `json:"settings"`');
    expect(code).toContain('Avatar []byte `json:"avatar"`');
  });

  it("omits the import block when unneeded", () => {
    const { code } = generateCode([col("name", "text")], "t", "go");
    expect(code).not.toContain("import (");
  });
});

describe("goImports", () => {
  it("collects time and json only when needed", () => {
    expect(goImports([col("a", "timestamptz"), col("b", "json")])).toEqual([
      "time",
      "encoding/json",
    ]);
    expect(goImports([col("a", "int")])).toEqual([]);
  });
});

describe("generateCode — jsonschema", () => {
  const { code } = generateCode(USERS, "users", "jsonschema");
  const schema = JSON.parse(code);

  it("emits draft 2020-12 with required from non-nullable", () => {
    expect(schema.$schema).toContain("2020-12");
    expect(schema.title).toBe("Users");
    expect(schema.properties.id).toEqual({
      type: "integer",
      "x-primary-key": true,
    });
    expect(schema.properties.display_name.type).toEqual(["string", "null"]);
    expect(schema.properties.settings).toEqual({});
    expect(schema.properties.avatar.contentEncoding).toBe("base64");
    expect(schema.required).toContain("id");
    expect(schema.required).not.toContain("display_name");
  });
});

describe("edge cases", () => {
  it("emits an empty shape for a columnless table", () => {
    const { code, fieldCount } = generateCode([], "empty", "typescript");
    expect(fieldCount).toBe(0);
    expect(code).toContain("export interface Empty {");
  });

  it("dedupes colliding column names", () => {
    const { code } = generateCode([col("a-b", "int"), col("a_b", "int")], "t", "rust");
    // both sanitize to a_b → second becomes a_b_2
    expect(code).toContain("pub a_b: i32,");
    expect(code).toContain("pub a_b_2: i32,");
  });
});
