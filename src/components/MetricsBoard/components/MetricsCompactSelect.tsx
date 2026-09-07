import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { MetricsSelectOption } from "../utils/query-builder";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MetricsCompactSelectProps<T extends string | number> {
  value: T;
  options: readonly MetricsSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}

export function MetricsCompactSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: MetricsCompactSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;

    const updateMenuPosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const estimatedHeight = Math.min(options.length * 32 + 14, 240);
      const spaceBelow = window.innerHeight - rect.bottom - 10;
      const shouldOpenUpward = spaceBelow < estimatedHeight && rect.top > estimatedHeight + 10;
      const top = shouldOpenUpward
        ? Math.max(8, rect.top - estimatedHeight - 6)
        : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 6);
      const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, rect.left));

      setMenuPosition({
        left,
        top,
        width: rect.width,
      });
    };

    updateMenuPosition();

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, options.length]);

  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className={`metrics-compact-select ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="metrics-compact-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedOption?.label}</span>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {open && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="metrics-compact-select-menu"
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: `${menuPosition.left}px`,
                top: `${menuPosition.top}px`,
                width: `${menuPosition.width}px`,
              }}
            >
              {options.map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`metrics-compact-select-option ${option.value === value ? "selected" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
