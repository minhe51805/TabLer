export function devLogError(...args: unknown[]) {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
}
