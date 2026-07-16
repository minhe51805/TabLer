import { useCallback, useEffect } from "react";

import { EventCenter } from "../stores/event-center";
import { useAppLayoutStore } from "../stores/appLayoutStore";
import type { RowInspectorData } from "../components/RowInspector/RowInspector";

export function useRowInspectorEvents() {
  const setRowInspectorData = useAppLayoutStore((state) => state.setRowInspectorData);
  const setShowRowInspector = useAppLayoutStore((state) => state.setShowRowInspector);

  const closeRowInspector = useCallback(() => {
    setShowRowInspector(false);
  }, [setShowRowInspector]);

  useEffect(() => {
    const offOpen = EventCenter.on("row-inspector-open", (event) => {
      setRowInspectorData(event.detail as RowInspectorData);
      setShowRowInspector(true);
    });
    const offClose = EventCenter.on("row-inspector-close", closeRowInspector);
    return () => {
      offOpen();
      offClose();
    };
  }, [closeRowInspector, setRowInspectorData, setShowRowInspector]);

  return closeRowInspector;
}
