/** Pane events remain generation-scoped; retry timing belongs to the server coordinator. */
export function shouldHandleTerminalGeneration(currentGeneration: number | undefined, eventGeneration: number) {
  return currentGeneration !== undefined && currentGeneration === eventGeneration;
}
