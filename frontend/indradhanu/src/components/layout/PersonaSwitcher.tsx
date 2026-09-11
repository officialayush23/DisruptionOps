import { useLocation, useNavigate } from "react-router-dom"
import { Building2, HardHat, User } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const PERSONAS = [
  {
    id: "admin",
    label: "Administration",
    short: "Admin",
    to: "/admin/risk",
    icon: Building2,
  },
  {
    id: "citizen",
    label: "Citizen",
    short: "Citizen",
    to: "/citizen",
    icon: User,
  },
  {
    id: "field",
    label: "Field operator",
    short: "Field",
    to: "/field",
    icon: HardHat,
  },
]

/** The three interfaces, switchable in one click so a judge can see the same
 *  moment in the event from all three sides. */
export function PersonaSwitcher() {
  const nav = useNavigate()
  const { pathname } = useLocation()
  const active = pathname.startsWith("/citizen")
    ? "citizen"
    : pathname.startsWith("/field")
      ? "field"
      : "admin"

  return (
    <ToggleGroup
      type="single"
      value={active}
      onValueChange={(v) => {
        const p = PERSONAS.find((x) => x.id === v)
        if (p) nav(p.to)
      }}
      variant="outline"
      size="sm"
    >
      {PERSONAS.map((p) => (
        <ToggleGroupItem
          key={p.id}
          value={p.id}
          aria-label={p.label}
          className="gap-1.5 px-2.5"
        >
          <p.icon className="size-3.5" />
          <span className="hidden text-xs sm:inline">{p.short}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
