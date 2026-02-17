/**
 * Route Context
 *
 * Manages the navigation state of the TUI application.
 * Switches between the "home" (landing/new session) and "session" (active conversation) views.
 */
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

/**
 * Landing view state.
 * Can optionally carry an `initialPrompt` to populate the textarea when moving from a session back to home.
 */
export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
}

/**
 * Active conversation view state.
 * Requires a `sessionID` to identify the thread being viewed.
 */
export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type Route = HomeRoute | SessionRoute

/**
 * The primary routing context for the application.
 * Initial state is determined by the `OPENCODE_ROUTE` environment variable (for hot-reloads/debug)
 * or defaults to the "home" view.
 */
export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const [store, setStore] = createStore<Route>(
      process.env["OPENCODE_ROUTE"]
        ? JSON.parse(process.env["OPENCODE_ROUTE"])
        : {
            type: "home",
          },
    )

    return {
      /**
       * Reactive access to the current route data.
       */
      get data() {
        return store
      },
      /**
       * Updates the global route state, triggering a re-render of the main App view.
       */
      navigate(route: Route) {
        console.log("navigate", route)
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

/**
 * Helper hook to access route data while asserting a specific route type.
 * Use this when you are certain you are on a specific page (e.g. within the <Session /> component).
 */
export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
