import type { RefObject } from "react";
import type { ConnectionConfig } from "../../../types";

export interface EngineFieldStrings {
  host: string;
  port: string;
  username: string;
  password: string;
  enterPassword: string;
  optional: string;
  databaseOptional: string;
  databaseName: string;
  databaseNamePlaceholder: string;
  databaseNameHint: string;
  databaseFile: string;
  defaultLocation: string;
  preparingSqliteLocation: string;
}

export interface PostgresFieldsProps {
  formData: ConnectionConfig;
  suggestedUsernamePlaceholder: string;
  strings: EngineFieldStrings;
  onFieldChange: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
}

export interface MySQLFieldsProps {
  formData: ConnectionConfig;
  suggestedUsernamePlaceholder: string;
  strings: EngineFieldStrings;
  onFieldChange: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
}

export interface SQLiteFieldsProps {
  formData: ConnectionConfig;
  bootstrapMode: boolean;
  strings: EngineFieldStrings;
  onFieldChange: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
}

export interface CommonFieldsProps {
  formData: ConnectionConfig;
  showPassword: boolean;
  suggestedUsernamePlaceholder: string;
  strings: EngineFieldStrings;
  passwordDraftRef: RefObject<string>;
  onFieldChange: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
  onTogglePasswordVisibility: () => void;
  onPasswordChange: (value: string) => void;
}
