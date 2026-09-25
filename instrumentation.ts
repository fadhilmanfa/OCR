export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOutputCleanup } = await import("./lib/jobs");
    startOutputCleanup();
  }
}
