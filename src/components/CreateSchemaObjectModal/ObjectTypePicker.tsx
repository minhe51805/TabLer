import { Eye, GitBranch, Table2 } from "lucide-react";
import { useI18n, type TranslationKey } from "../../i18n";

export type WizardKind = "table" | "view" | "trigger";

interface ObjectTypePickerProps {
  availableKinds: WizardKind[];
  activeKind: WizardKind;
  onKindChange: (kind: WizardKind) => void;
  onValidationClear: () => void;
}

const KIND_LABEL_KEYS: Record<WizardKind, TranslationKey> = {
  table: "schemaWizard.kind.table",
  view: "schemaWizard.kind.view",
  trigger: "schemaWizard.kind.trigger",
};

export function ObjectTypePicker({
  availableKinds,
  activeKind,
  onKindChange,
  onValidationClear,
}: ObjectTypePickerProps) {
  const { t } = useI18n();
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
          <span>{t(KIND_LABEL_KEYS[wizardKind])}</span>
        </button>
      ))}
    </div>
  );
}
