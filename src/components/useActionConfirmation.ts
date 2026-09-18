import { onBeforeUnmount, ref } from "vue";

/** App-owned confirmation works in desktop WebViews without native JS dialog handlers. */
export function useActionConfirmation() {
  const confirmationMessage = ref("");
  let pending: ((result: boolean) => void) | undefined;
  function resolveConfirmation(result: boolean) {
    const callback = pending; pending = undefined; confirmationMessage.value = ""; callback?.(result);
  }
  function confirmAction(message: string) {
    resolveConfirmation(false);
    confirmationMessage.value = message;
    return new Promise<boolean>(resolve => { pending = resolve; });
  }
  onBeforeUnmount(() => resolveConfirmation(false));
  return { confirmationMessage, confirmAction, resolveConfirmation };
}
