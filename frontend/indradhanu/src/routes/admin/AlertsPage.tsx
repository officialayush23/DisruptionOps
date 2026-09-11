import { Clock, MapPin, Radio, Users } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SeverityBadge, StatTile } from "@/components/common/indicators"
import { timeOf } from "@/lib/format"
import { useAlerts } from "@/hooks/useApi"
import { wardName } from "@/api/mock/geo"
import { Empty } from "./DecisionGate"

const CHANNEL_LABEL: Record<string, string> = {
  push: "App push",
  sms: "SMS",
  web: "Public web link",
  whatsapp: "WhatsApp forward",
}

export default function AlertsPage() {
  const { data: alerts = [] } = useAlerts()

  if (!alerts.length) {
    return (
      <Empty
        icon={<Radio className="size-8 text-muted-foreground" />}
        title="No alerts issued"
        body="Advisories appear here once they clear the decision gate — with the clause that authorised them and the reach they achieved."
      />
    )
  }

  const reach = alerts.reduce((a, x) => a + x.reach, 0)

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Issued alerts</h1>
        <p className="text-sm text-muted-foreground">
          Four fields only: what is happening, where the resident is in it, by
          when to act, and where to go. Anything longer does not get read at 2
          a.m.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Advisories issued"
          value={String(alerts.length)}
          sub="across wards"
        />
        <StatTile
          label="Residents reached"
          value={reach.toLocaleString("en-IN")}
          sub="estimated"
        />
        <StatTile label="Channels" value="4" sub="push, SMS, web, WhatsApp" />
        <StatTile label="Languages" value="3" sub="Marathi, Hindi, English" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {alerts.map((a) => (
          <Card key={a.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">
                    {wardName(a.wardId)}
                  </CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    issued {timeOf(a.issuedAt)} IST · {a.language}
                  </p>
                </div>
                <SeverityBadge severity={a.severity} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 rounded-md bg-muted p-3">
                <p className="font-semibold">{a.headline}</p>
                <p className="text-sm">{a.action}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="size-3" />
                    Leave by {timeOf(a.byTime)}
                  </span>
                  {a.safeLocation && (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="size-3" />
                      {a.safeLocation.name} · {a.safeLocation.distanceKm} km
                    </span>
                  )}
                </div>
              </div>

              <Separator />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {a.channels.map((c) => (
                    <Badge key={c} variant="outline" className="text-[10px]">
                      {CHANNEL_LABEL[c]}
                    </Badge>
                  ))}
                </div>
                <span className="tabular inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="size-3" />
                  {a.reach.toLocaleString("en-IN")} reached
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
