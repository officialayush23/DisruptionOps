import type { IndradhanuApi } from "./types"
import { mockClient } from "./mock/mockClient"

/** Swap point.
 *
 *  `mock`  - the scripted world in `api/mock`, no backend required.
 *  `http`  - the FastAPI service at VITE_API_URL, authenticated with the
 *            signed-in user's Supabase access token.
 *
 *  The HTTP client now exists (`api/httpClient.ts`). It is not yet a drop-in
 *  `IndradhanuApi`: the screens are being moved across one at a time, starting
 *  with the ones the first real run fills. Until a screen is migrated it keeps
 *  reading the mock, so the app never half-loads.
 *
 *  Import the typed functions from `api/httpClient` directly in a migrated
 *  screen. `apiMode` below tells a screen which world it is in.
 */
const MODE = (import.meta.env.VITE_API_MODE as string | undefined) ?? "mock"

export const apiBaseUrl =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""

export const api: IndradhanuApi = mockClient
export const apiMode = MODE
export const isLive = MODE === "http" && Boolean(apiBaseUrl)

export * from "./httpClient"
