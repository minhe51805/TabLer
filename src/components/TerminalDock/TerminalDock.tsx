import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RotateCcw, SquareTerminal, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useI18n } from "../../i18n";
import "@xterm/xterm/css/xterm.css";
import "../../styles/lazy-overlays.css";

interface TerminalDockProps {
  isOpen: boolean;
  onClose: () => void;
  databaseContext?: TerminalDatabaseContext;
}

interface TerminalDatabaseContext {
  connectionId: string;
  connectionName: string;
  dbType: string;
  database?: string;
  host?: string;
  port?: number;
  username?: string;
  filePath?: string;
}

interface TerminalSessionInfo {
  sessionId: string;
  shellLabel: string;
  cwd: string;
}

interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}

interface TerminalExitPayload {
  sessionId: string;
  reason: string;
}

function getTerminalTheme() {
  // Fixed dark palette, deliberately NOT derived from the app theme: a light
  // app theme has a dark --text-primary, which made the PowerShell prompt
  // blend into the terminal background. Terminals stay dark by convention.
  return {
    background: "#0b1220",
    foreground: "#d7e4f1",
    cursor: "#00d4aa",
    cursorAccent: "#0b1220",
    selectionBackground: "rgba(34, 211, 238, 0.28)",
    black: "#0d1726",
    red: "#ff7a90",
    green: "#00d4aa",
    yellow: "#f4d35e",
    blue: "#22d3ee",
    magenta: "#8b8dff",
    cyan: "#22d3ee",
    white: "#e6eef7",
    brightBlack: "#8b9bb0",
    brightRed: "#ff98a9",
    brightGreen: "#4ef2c5",
    brightYellow: "#ffe08a",
    brightBlue: "#6fdcff",
    brightMagenta: "#b1b4ff",
    brightCyan: "#8bf0ff",
    brightWhite: "#ffffff",
  };
}

export function TerminalDock({
  isOpen,
  onClose,
  databaseContext,
}: TerminalDockProps) {
  const { language } = useI18n();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const terminalDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const sessionIdRef = useRef<string>(
    `workspace-terminal-${crypto.randomUUID()}`,
  );
  const databaseContextRef = useRef<TerminalDatabaseContext | undefined>(
    databaseContext,
  );
  const appliedDatabaseContextKeyRef = useRef<string | null>(null);
  const hasInitializedRef = useRef(false);
  const hasStartedSessionRef = useRef(false);
  const [hasBooted, setHasBooted] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<TerminalSessionInfo | null>(
    null,
  );
  const [isExited, setIsExited] = useState(false);

  const databaseContextKey = [
    databaseContext?.connectionId,
    databaseContext?.database,
    databaseContext?.host,
    databaseContext?.port,
    databaseContext?.username,
    databaseContext?.filePath,
  ].join("\u0000");

  useEffect(() => {
    databaseContextRef.current = databaseContext;
  }, [databaseContext]);

  const terminalText =
    language === "vi"
      ? {
          title: "Terminal",
          fallbackShell: "Shell",
          loading: "Dang chuan bi shell...",
          live: "Dang chay",
          exited: "Da thoat",
          clear: "Xoa",
          restart: "Khoi dong lai",
          hide: "An terminal",
        }
      : {
          title: "Terminal",
          fallbackShell: "Shell",
          loading: "Preparing shell...",
          live: "Live",
          exited: "Exited",
          clear: "Clear",
          restart: "Restart",
          hide: "Hide terminal",
        };

  const fitTerminal = useCallback(() => {
    if (!isOpen) return;
    if (!viewportRef.current || !terminalRef.current || !fitAddonRef.current)
      return;
    if (
      viewportRef.current.clientWidth === 0 ||
      viewportRef.current.clientHeight === 0
    )
      return;

    fitAddonRef.current.fit();
    // The PTY does not exist before the session spawns; without this guard
    // early fits only produce "session not found" noise in the console.
    if (!hasStartedSessionRef.current) return;
    void invoke("resize_terminal", {
      sessionId: sessionIdRef.current,
      cols: terminalRef.current.cols,
      rows: terminalRef.current.rows,
    }).catch((error) => {
      console.error("Failed to resize terminal", error);
    });
  }, [isOpen]);

  // The dock animates open/closed, so the ResizeObserver fires a burst of
  // resizes. Resizing ConPTY on every frame garbles PowerShell's render
  // (PSReadLine redraws mid-resize), so coalesce them with a short debounce.
  const resizeDebounceRef = useRef<number | null>(null);
  const debouncedFitTerminal = useCallback(() => {
    if (resizeDebounceRef.current !== null) {
      window.clearTimeout(resizeDebounceRef.current);
    }
    resizeDebounceRef.current = window.setTimeout(() => {
      resizeDebounceRef.current = null;
      fitTerminal();
    }, 120);
  }, [fitTerminal]);

  const startTerminalSession = useCallback(
    async (forceRestart = false) => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      if (forceRestart && hasStartedSessionRef.current) {
        await invoke("close_terminal", {
          sessionId: sessionIdRef.current,
        }).catch((error) => {
          console.error("Failed to close terminal session", error);
        });
        hasStartedSessionRef.current = false;
        sessionIdRef.current = `workspace-terminal-${crypto.randomUUID()}`;
      }

      const info = await invoke<TerminalSessionInfo>("open_terminal", {
        sessionId: sessionIdRef.current,
        cols: Math.max(terminal.cols, 20),
        rows: Math.max(terminal.rows, 8),
        cwd: null,
        databaseContext: databaseContextRef.current ?? null,
      });

      hasStartedSessionRef.current = true;
      appliedDatabaseContextKeyRef.current = databaseContextKey;
      setSessionInfo(info);
      setIsExited(false);
    },
    [databaseContextKey],
  );

  const handleRestart = useCallback(async () => {
    terminalRef.current?.clear();
    terminalRef.current?.write("\u001bc");
    await startTerminalSession(true);
    terminalRef.current?.focus();
    fitTerminal();
  }, [fitTerminal, startTerminalSession]);

  useEffect(() => {
    if (
      !hasStartedSessionRef.current ||
      appliedDatabaseContextKeyRef.current === null ||
      appliedDatabaseContextKeyRef.current === databaseContextKey
    ) {
      return;
    }

    void handleRestart();
  }, [databaseContextKey, handleRestart]);

  useEffect(() => {
    if (isOpen) {
      setHasBooted(true);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!hasBooted || hasInitializedRef.current || !viewportRef.current) {
      return;
    }

    let cancelled = false;
    let initializationCleanup: (() => void) | null = null;

    // Deferred until the dock finishes opening: initializing xterm and
    // spawning the PTY mid-transition gave the shell a wrong size (PowerShell
    // rendered no prompt) and a blurry, stretched renderer.
    const runInitialization = () => {
      if (cancelled || hasInitializedRef.current || !viewportRef.current) {
        return;
      }

    const terminal = new XTerm({
      // Opaque background keeps glyph anti-aliasing crisp; transparency
      // renders text without a solid backdrop and looks blurry.
      allowTransparency: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily:
        "Consolas, 'Cascadia Mono', 'SFMono-Regular', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(viewportRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    hasInitializedRef.current = true;

    fitAddon.fit();

    terminalDisposablesRef.current.push(
      terminal.onData((data) => {
        void invoke("write_terminal", {
          sessionId: sessionIdRef.current,
          data,
        }).catch((error) => {
          console.error("Failed to send terminal input", error);
        });
      }),
    );

    terminalDisposablesRef.current.push(
      terminal.onResize(({ cols, rows }) => {
        void invoke("resize_terminal", {
          sessionId: sessionIdRef.current,
          cols,
          rows,
        }).catch((error) => {
          console.error("Failed to resize terminal", error);
        });
      }),
    );

    const observer = new ResizeObserver(() => {
      debouncedFitTerminal();
    });
    observer.observe(viewportRef.current);
    resizeObserverRef.current = observer;

    let isMounted = true;

    void (async () => {
      const unlistenOutput = await listen<TerminalOutputPayload>(
        "terminal-output",
        (event) => {
          if (event.payload.sessionId !== sessionIdRef.current) return;
          terminalRef.current?.write(event.payload.data);
        },
      );

      const unlistenExit = await listen<TerminalExitPayload>(
        "terminal-exit",
        (event) => {
          if (event.payload.sessionId !== sessionIdRef.current) return;
          hasStartedSessionRef.current = false;
          setIsExited(true);
          terminalRef.current?.writeln(`\r\n[${event.payload.reason}]`);
        },
      );

      if (!isMounted) {
        unlistenOutput();
        unlistenExit();
        return;
      }

      unlistenRef.current = [unlistenOutput, unlistenExit];

      try {
        await startTerminalSession(false);
        terminal.focus();
        fitTerminal();
      } catch (error) {
        console.error("Failed to start terminal session", error);
        terminal.writeln("\r\n[Failed to start terminal shell]");
      }
    })();

    return () => {
      isMounted = false;
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      terminalDisposablesRef.current.forEach((disposable) =>
        disposable.dispose(),
      );
      terminalDisposablesRef.current = [];
      unlistenRef.current.forEach((unlisten) => void unlisten());
      unlistenRef.current = [];
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      hasInitializedRef.current = false;
      hasStartedSessionRef.current = false;
      void invoke("close_terminal", { sessionId: sessionIdRef.current }).catch(
        () => undefined,
      );
    };
    };

    // Kick off once the open transition (max-height) finishes, falling back
    // to a timeout for first-open/no-transition and reduced-motion setups.
    const shell = shellRef.current;
    const settleTimer = window.setTimeout(() => {
      initializationCleanup = runInitialization() ?? null;
    }, 420);
    const onDockTransitionEnd = (event: TransitionEvent) => {
      if (event.target === shell && event.propertyName === "max-height") {
        window.clearTimeout(settleTimer);
        initializationCleanup = runInitialization() ?? null;
      }
    };
    shell?.addEventListener("transitionend", onDockTransitionEnd);

    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      shell?.removeEventListener("transitionend", onDockTransitionEnd);
      initializationCleanup?.();
      initializationCleanup = null;
    };
  }, [debouncedFitTerminal, fitTerminal, hasBooted, startTerminalSession]);

  useEffect(() => {
    if (!isOpen || !hasBooted) return;

    const frameId = window.requestAnimationFrame(() => {
      fitTerminal();
      terminalRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [fitTerminal, hasBooted, isOpen]);

  return (
    <section
      ref={shellRef}
      className={`workspace-terminal-dock ${isOpen ? "is-open" : ""}`}
      aria-hidden={!isOpen}
    >
      <div className="workspace-terminal-header">
        <div className="workspace-terminal-meta">
          <div className="workspace-terminal-badge">
            <SquareTerminal className="w-3.5 h-3.5" />
            <span>{terminalText.title}</span>
          </div>
          <div className="workspace-terminal-copy">
            <strong>
              {sessionInfo?.shellLabel || terminalText.fallbackShell}
            </strong>
            <span>
              {databaseContext
                ? `${databaseContext.connectionName} | ${databaseContext.database || databaseContext.dbType.toUpperCase()}`
                : sessionInfo?.cwd || terminalText.loading}
            </span>
          </div>
          <span
            className={`workspace-terminal-state ${isExited ? "is-exited" : ""}`}
          >
            {isExited ? terminalText.exited : terminalText.live}
          </span>
        </div>

        <div className="workspace-terminal-actions">
          <button
            type="button"
            className="workspace-terminal-btn"
            onClick={() => terminalRef.current?.clear()}
            title={terminalText.clear}
          >
            {terminalText.clear}
          </button>
          <button
            type="button"
            className="workspace-terminal-btn"
            onClick={() => void handleRestart()}
            title={terminalText.restart}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{terminalText.restart}</span>
          </button>
          <button
            type="button"
            className="workspace-terminal-btn icon-only"
            onClick={onClose}
            title={terminalText.hide}
            aria-label={terminalText.hide}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="workspace-terminal-body">
        <div ref={viewportRef} className="workspace-terminal-viewport" />
      </div>
    </section>
  );
}
