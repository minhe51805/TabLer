import { ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { useSafeModeStore } from "../../stores/safeModeStore";
import { CONNECTION_ENVIRONMENT_LABELS, SAFE_MODE_LABELS, type ConnectionEnvironment, type SafeModeLevel } from "../../types/safe-mode";

interface Props {
  connectionId: string;
  connectionName: string;
  onClose: () => void;
}

const ENVIRONMENTS: ConnectionEnvironment[] = ["development", "staging", "production", "unknown"];
const LEVELS: SafeModeLevel[] = [0, 1, 2, 3, 4, 5];

export function ConnectionSafetyProfileModal({ connectionId, connectionName, onClose }: Props) {
  const getConnectionEnvironment = useSafeModeStore((state) => state.getConnectionEnvironment);
  const getEffectiveLevel = useSafeModeStore((state) => state.getEffectiveLevelForConnection);
  const setConnectionEnvironment = useSafeModeStore((state) => state.setConnectionEnvironment);
  const setConnectionOverride = useSafeModeStore((state) => state.setConnectionOverride);
  const [environment, setEnvironment] = useState<ConnectionEnvironment>(() => getConnectionEnvironment(connectionId));
  const [level, setLevel] = useState<SafeModeLevel>(() => getEffectiveLevel(connectionId));

  const save = () => {
    setConnectionEnvironment(connectionId, environment);
    setConnectionOverride(connectionId, level);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-md mx-4" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
          <span className="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-500 inline-flex items-center justify-center"><ShieldCheck className="w-5 h-5" /></span>
          <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Connection safety</h2><p className="text-xs text-[var(--text-muted)] truncate">{connectionName}</p></div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <label className="connection-form-field"><span className="form-label">Environment</span><select className="input h-10" value={environment} onChange={(event) => setEnvironment(event.target.value as ConnectionEnvironment)}>{ENVIRONMENTS.map((item) => <option key={item} value={item}>{CONNECTION_ENVIRONMENT_LABELS[item]}</option>)}</select></label>
          <label className="connection-form-field"><span className="form-label">Safety profile</span><select className="input h-10" value={level} onChange={(event) => setLevel(Number(event.target.value) as SafeModeLevel)}>{LEVELS.map((item) => <option key={item} value={item}>Level {item}: {SAFE_MODE_LABELS[item].label}</option>)}</select></label>
          <p className="text-xs text-[var(--text-muted)]">Production should normally use Strict or Paranoid. Read Only blocks every write statement.</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border)]"><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save profile</button></div>
      </div>
    </div>
  );
}
