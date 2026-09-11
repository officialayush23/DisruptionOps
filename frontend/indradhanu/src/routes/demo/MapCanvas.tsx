/** Superseded by `@/components/map/LiveMap`.
 *
 *  This was the hand-rolled SVG map. It is gone: the console, the citizen portal
 *  and the field portal all draw the same Mapbox component now, so there is one
 *  answer to where a thing is instead of two that can drift apart.
 *
 *  The file is kept only so that anything still importing it fails loudly at the
 *  import rather than silently rendering an old map. Delete it once you have
 *  confirmed nothing does.
 */
export { LiveMap as default } from "@/components/map/LiveMap"
