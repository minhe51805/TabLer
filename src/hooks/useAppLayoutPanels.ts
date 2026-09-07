import { useState } from 'react';

export function useAppLayoutPanels() {
  const [showRowInspector, setShowRowInspector] = useState(false);
  const [showTerminalPanel, setShowTerminalPanel] = useState(false);
  // Add more layout states here

  return {
    showRowInspector, setShowRowInspector,
    showTerminalPanel, setShowTerminalPanel
  };
}
