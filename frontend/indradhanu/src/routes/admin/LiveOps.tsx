/** Superseded by `@/routes/demo/DemoConsole`.
 *
 *  There were two consoles, "live operations" and "live demo", showing
 *  overlapping halves of the same world. There is one now, at /admin/console,
 *  and the old paths redirect to it.
 *
 *  Kept only so that anything still importing this fails at the import rather
 *  than rendering a second, stale console. Delete it once nothing does.
 */
export { default } from "@/routes/demo/DemoConsole"
