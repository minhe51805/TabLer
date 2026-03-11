import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

interface Props {
  initialCwd?: string;
}

interface TerminalOutputEvent {
  session_id: string;
  stream: "stdout" | "stderr";
  text: string;
}

export function TerminalPanel({ initialCwd = "." }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      disableStdin: false,
      convertEol: false,
      fontFamily: "JetBrains Mono, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#070f2a",
        foreground: "#dbe7ff",
        cursor: "#89b4fa",
      },
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    // Don't auto-focus immediately, let user click to focus
    term.write("Starting terminal session...\r\n");

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    setTerminalReady(true);

    const onResize = () => fitAddon.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Wait for terminal to be initialized
    if (!terminalReady || !terminalRef.current) return;

    let unlisten: UnlistenFn | null = null;
    let activeSessionId: string | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let cancelled = false;

    const boot = async () => {
      try {
        const sid = await invoke<string>("start_terminal_session", { cwd: initialCwd });
        if (cancelled) {
          await invoke("stop_terminal_session", { sessionId: sid });
          return;
        }

        activeSessionId = sid;
        setSessionId(sid);

        unlisten = await listen<TerminalOutputEvent>("terminal-output", (event) => {
          const payload = event.payload;
          if (!activeSessionId || payload.session_id !== activeSessionId) return;
          terminalRef.current?.write(payload.text);
        });

        // Register input handler - xterm.js will handle local echo automatically
        if (terminalRef.current) {
          const term = terminalRef.current;
          // Ensure stdin is enabled
          term.options.disableStdin = false;
          
          // Small delay to ensure terminal is fully ready
          await new Promise(resolve => setTimeout(resolve, 100));
          
          let commandBuffer = "";

          inputDisposable = term.onData(async (data) => {
            if (!activeSessionId) {
              console.warn("Terminal input: no active session");
              return;
            }
            
            // Handle different key presses for a rudimentary interactive terminal experience
            // over a raw pipe.
            
            if (data === '\r') { // Enter
              term.write('\r\n');
              
              const commandToSend = commandBuffer + '\n'; // \n is generally accepted by both bash and cmd
              commandBuffer = "";
              
              try {
                await invoke("send_terminal_input", {
                  sessionId: activeSessionId,
                  input: commandToSend,
                });
              } catch (err) {
                console.error("Terminal input error:", err);
                term.write(`\r\n[terminal input error: ${String(err)}]\r\n`);
              }
            } else if (data === '\x7f' || data === '\b') { // Backspace
              if (commandBuffer.length > 0) {
                commandBuffer = commandBuffer.slice(0, -1);
                term.write('\b \b');
              }
            } else if (data === '\x03') { // Ctrl+C
               commandBuffer = "";
               term.write('^C\r\n');
            } else {
              // Normal character
              // Ignore ansi escapes or arrow keys for simple buffer
              if (data.length === 1 && data.charCodeAt(0) >= 32) {
                commandBuffer += data;
                term.write(data);
              }
            }
          }) as { dispose: () => void };
          
          term.write("\r\n$ "); // Print initial prompt
          
          // Test: verify terminal can receive input
          console.log("Terminal input handler registered, disableStdin:", term.options.disableStdin);
          
          // Ensure terminal is focused and ready for input
          setTimeout(() => {
            term.focus();
          }, 100);
        }
      } catch (e) {
        terminalRef.current?.write(`Failed to start terminal: ${String(e)}\r\n`);
      }
    };

    void boot();

    return () => {
      cancelled = true;
      if (inputDisposable) inputDisposable.dispose();
      if (unlisten) void unlisten();
      if (activeSessionId) {
        void invoke("stop_terminal_session", { sessionId: activeSessionId });
      }
    };
  }, [initialCwd, terminalReady]);

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] text-xs text-[var(--text-secondary)]">
        Integrated Terminal {sessionId ? `· ${sessionId.slice(0, 8)}` : ""}
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 px-2 py-1 cursor-text"
        onClick={() => {
          if (terminalRef.current) {
            terminalRef.current.focus();
            // Force focus on the textarea
            setTimeout(() => {
              const textarea = containerRef.current?.querySelector(".xterm textarea") as HTMLTextAreaElement | null;
              if (textarea) {
                textarea.focus();
                textarea.click();
              }
            }, 50);
          }
        }}
        onFocus={() => {
          if (terminalRef.current) {
            terminalRef.current.focus();
          }
        }}
        tabIndex={0}
      />
    </div>
  );
}
