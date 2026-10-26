import { onBeforeUnmount, ref } from "vue";

/** App-owned confirmation works in desktop WebViews without native JS dialog handlers. */
export function useActionConfirmation() {
  const confirmationMessage = ref("");
  const confirmationId = ref(0);
  let pending: ((result: boolean) => void) | undefined;
  function resolveConfirmation(result: boolean, requestId = confirmationId.value) {
    if (requestId !== confirmationId.value) return;
    const callback = pending; pending = undefined; confirmationMessage.value = ""; callback?.(result);
  }
  function confirmAction(message: string) {
    resolveConfirmation(false);
    confirmationId.value += 1;
    confirmationMessage.value = message;
    return new Promise<boolean>(resolve => { pending = resolve; });
  }
  onBeforeUnmount(() => resolveConfirmation(false));
  return { confirmationMessage, confirmationId, confirmAction, resolveConfirmation };
}
