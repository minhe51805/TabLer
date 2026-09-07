import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface ERDSelectOption {
  value: string;
  label: string;
  meta?: string;
}

interface ERDCompactSelectProps {
  value: string;
  options: readonly ERDSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}

export function ERDCompactSelect({ value, options, onChange, ariaLabel }: ERDCompactSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;

    const updateMenuPosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const estimatedHeight = Math.min(options.length * 42 + 12, 280);
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
    <div className={`erd-compact-select ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="erd-compact-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="erd-compact-select-trigger-copy">
          <span className="erd-compact-select-trigger-label">{selectedOption?.label}</span>
          {selectedOption?.meta ? <span className="erd-compact-select-trigger-meta">{selectedOption.meta}</span> : null}
        </span>
        <ChevronDown className="erd-compact-select-trigger-icon" />
      </button>

      {open && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="erd-compact-select-menu"
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
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`erd-compact-select-option ${option.value === value ? "selected" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="erd-compact-select-option-copy">
                    <span className="erd-compact-select-option-label">{option.label}</span>
                    {option.meta ? <span className="erd-compact-select-option-meta">{option.meta}</span> : null}
                  </span>
                  {option.value === value ? <Check className="erd-compact-select-option-check" /> : null}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
