/**
 * Selection Utility
 *
 * Provides a bridge between the terminal's text selection state and the system clipboard.
 * Implements "Copy on Command" logic common in terminal emulators.
 */
import { Clipboard } from "./clipboard"

/**
 * Minimal interface for the UI toast notification system.
 */
type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

/**
 * Minimal interface for the terminal renderer's selection state.
 */
type Renderer = {
  getSelection: () => { getSelectedText: () => string } | null
  clearSelection: () => void
}

export namespace Selection {
  /**
   * Captures the current selection from the renderer, writes it to the
   * system clipboard, and provides UI feedback via toasts.
   *
   * returns true if a selection existed and was copied.
   */
  export function copy(renderer: Renderer, toast: Toast): boolean {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text) return false

    Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
    return true
  }
}
