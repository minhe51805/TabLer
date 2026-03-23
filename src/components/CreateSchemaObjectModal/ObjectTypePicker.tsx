import { Eye, GitBranch, Table2 } from "lucide-react";

export type WizardKind = "table" | "view" | "trigger";

interface ObjectTypePickerProps {
  availableKinds: WizardKind[];
  activeKind: WizardKind;
  onKindChange: (kind: WizardKind) => void;
  onValidationClear: () => void;
}

const KIND_LABELS: Record<WizardKind, string> = {
  table: "Table",
  view: "View",
  trigger: "Trigger",
};

export function ObjectTypePicker({
  availableKinds,
  activeKind,
  onKindChange,
  onValidationClear,
}: ObjectTypePickerProps) {
  return (
    <div className="schema-wizard-tabs">
      {availableKinds.map((wizardKind) => (
        <button
          key={wizardKind}
          type="button"
          className={`schema-wizard-tab ${wizardKind === activeKind ? "active" : ""}`}
          onClick={() => {
            onKindChange(wizardKind);
            onValidationClear();
          }}
        >
          {wizardKind === "table" && <Table2 className="w-4 h-4" />}
          {wizardKind === "view" && <Eye className="w-4 h-4" />}
          {wizardKind === "trigger" && <GitBranch className="w-4 h-4" />}
          <span>{KIND_LABELS[wizardKind]}</span>
        </button>
      ))}
    </div>
  );
}
