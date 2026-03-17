export function emitLitDebugEvent(onDebugEvent, event) {
  if (typeof onDebugEvent !== "function") {
    return;
  }

  onDebugEvent({
    scope: "lit",
    timestamp: new Date().toISOString(),
    ...event,
  });
}

export function emitLitProgressEvent(onProgressEvent, event) {
  if (typeof onProgressEvent !== "function") {
    return;
  }

  onProgressEvent({
    scope: "lit",
    timestamp: new Date().toISOString(),
    ...event,
  });
}
