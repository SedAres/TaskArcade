/* ==========================================================================
   TaskArcade — refresh bridge
   A one-line module whose only job is to break an import cycle: modules that
   need to trigger a full state refresh register themselves here during boot,
   and modules that want to refresh import `requestRefresh()` instead of
   importing the app shell.
   ========================================================================== */

let impl = async () => {};

export function provideRefreshBridge(fn) {
  if (typeof fn === "function") impl = fn;
}

export async function requestRefresh(options) {
  return impl(options);
}
