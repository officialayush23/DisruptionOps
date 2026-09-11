import type { IndradhanuApi } from "./types"
import { mockClient } from "./mock/mockClient"

/** Swap point.
 *
 *  `mock`  - the scripted world in `api/mock`, no backend required.
 *  `http`  - the FastAPI service at VITE_API_URL.
 *
 *  Both implement `IndradhanuApi`, so switching is this file and nothing else.
 *  Until the httpClient lands, an explicit `http` setting falls back to mock
 *  with a console warning rather than failing silently at runtime.
 */
const MODE = (import.meta.env.VITE_API_MODE as string | undefined) ?? "mock"

export const apiBaseUrl =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""

function selectClient(): IndradhanuApi {
  if (MODE === "http") {
    if (!apiBaseUrl) {
      console.warn(
        "[indradhanu] VITE_API_MODE=http but VITE_API_URL is unset; using the mock client."
      )
      return mockClient
    }
    console.warn(
      "[indradhanu] The HTTP client is not wired yet; using the mock client against",
      apiBaseUrl
    )
    return mockClient
  }
  return mockClient
}

export const api: IndradhanuApi = selectClient()

export const apiMode = MODE
