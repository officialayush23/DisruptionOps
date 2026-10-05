import { useMemo } from "react"
import { shortHash } from "@/lib/ledger/crypto"
import type { DAGBlock, VerificationResult } from "@/lib/ledger/types"
import { TYPE_STYLE } from "./style"

const W = 168, H = 58, GX = 214, GY = 78, PAD = 24

/** Blocks as nodes, parent -> child as edges, laid out by height (left to right). */
export default function DAGCanvas({ blocks, verified, selected, pending, onSelect }: {
  blocks: DAGBlock[]
  verified: Record<string, VerificationResult>
  selected: string | null
  /** Blocks held by a partitioned peer, not yet merged: drawn dashed. */
  pending?: Set<string>
  onSelect: (hash: string) => void
}) {
  const layout = useMemo(() => {
    const cols = new Map<number, DAGBlock[]>()
    for (const b of blocks) cols.set(b.height, [...(cols.get(b.height) ?? []), b])
    const pos: Record<string, { x: number; y: number }> = {}
    let rows = 1
    for (const [h, list] of cols) {
      list.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.hash.localeCompare(b.hash))
      rows = Math.max(rows, list.length)
      list.forEach((b, i) => { pos[b.hash] = { x: PAD + h * GX, y: PAD + i * GY } })
    }
    const maxH = Math.max(0, ...blocks.map((b) => b.height))
    return { pos, width: PAD * 2 + maxH * GX + W, height: PAD * 2 + (rows - 1) * GY + H }
  }, [blocks])

  if (!blocks.length) {
    return <div className="text-muted-foreground grid h-full place-items-center text-sm">No blocks yet.</div>
  }
  return (
    <div className="h-full w-full overflow-auto">
      <svg width={layout.width} height={layout.height} className="block">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        {blocks.flatMap((b) => b.parents.map((p) => {
          const a = layout.pos[p], c = layout.pos[b.hash]
          if (!a || !c) return null
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = c.x - 4, y2 = c.y + H / 2, mx = (x1 + x2) / 2
          return <path key={`${p}-${b.hash}`} d={`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} fill="none"
            stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeWidth={1.4}
            strokeDasharray={pending?.has(b.hash) ? "5 4" : undefined} markerEnd="url(#arrow)" />
        }))}
        {blocks.map((b) => {
          const p = layout.pos[b.hash], st = TYPE_STYLE[b.payloadType], v = verified[b.hash]
          const sel = b.hash === selected
          return (
            <g key={b.hash} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect(b.hash)} className="cursor-pointer">
              <rect width={W} height={H} rx={8} fill="var(--card)" stroke={sel ? "var(--primary)" : "var(--border)"}
                strokeWidth={sel ? 2.5 : 1} strokeDasharray={pending?.has(b.hash) ? "5 4" : undefined} />
              <rect width={5} height={H} rx={2} fill={st.color} />
              <text x={14} y={19} fontSize={11} fontWeight={600} fill={st.color}>{st.label}</text>
              <text x={14} y={36} fontSize={11} fontFamily="ui-monospace,monospace" fill="var(--foreground)">{shortHash(b.hash)}</text>
              <text x={14} y={50} fontSize={9.5} fill="var(--muted-foreground)">
                {b.issuer.length > 22 ? `${b.issuer.slice(0, 21)}…` : b.issuer}{b.payloadCID ? " · CID" : ""}
              </text>
              {v && (
                <g transform={`translate(${W - 20},8)`}>
                  <circle cx={6} cy={6} r={7} fill={v.ok ? "#16a34a" : "#dc2626"} />
                  <text x={6} y={9.5} fontSize={10} fontWeight={700} textAnchor="middle" fill="#fff">{v.ok ? "✓" : "!"}</text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
