"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MatchesDialog } from "@/components/interest";
import {
  Badge,
  Button,
  Card,
  PageHeader,
  Select,
  Stat,
  Table,
  Tabs,
  Td,
} from "@/components/ui";
import { api } from "@/lib/api";
import { fmtOre, fmtPct, OBJECT_TYPE_LABEL } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Vacancy, VacancyOverview } from "@/lib/vacancies";

type Tab = "now" | "coming";

export default function VacanciesPage() {
  const { active, can, version } = useSession();
  const [data, setData] = useState<VacancyOverview | null>(null);
  const [tab, setTab] = useState<Tab>("now");
  const [propertyId, setPropertyId] = useState("");
  const [properties, setProperties] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [matching, setMatching] = useState<Vacancy | null>(null);

  const load = () =>
    api<VacancyOverview>(
      `/vacancies${propertyId ? `?propertyId=${propertyId}` : ""}`,
    ).then(setData);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, version]);
  useEffect(() => {
    api<{ id: string; name: string }[]>("/properties")
      .then(setProperties)
      .catch(() => setProperties([]));
  }, [version]);

  const s = data?.summary;
  const rows = tab === "now" ? data?.vacantNow : data?.coming;
  const canManage = !!active && can("interest.manage");

  return (
    <>
      <PageHeader
        title="Lediga objekt"
        description="Objekt som står lediga i dag och objekt som blir lediga när ett avtal tar slut. Räknas fram ur avtalen."
        actions={
          <Link href="/intresse">
            <Button variant="secondary">
              Intresselista{s ? ` (${s.interested})` : ""}
            </Button>
          </Link>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat
          label="Lediga i dag"
          value={s?.vacantNow ?? "–"}
          sub={s ? `av ${s.totalObjects} objekt` : undefined}
        />
        <Stat
          label="Uthyrningsgrad"
          value={s?.occupancyPct != null ? fmtPct(s.occupancyPct / 100) : "–"}
          sub="andel objekt som är uthyrda i dag"
        />
        <Stat
          label="Hyresbortfall per månad"
          value={fmtOre(s?.monthlyLostOre)}
          sub={s ? `${fmtOre(s.lostThisYearOre)} hittills i år` : undefined}
        />
        <Stat
          label="Blir lediga"
          value={s?.coming ?? "–"}
          sub={s ? `${fmtOre(s.comingMonthlyOre)} i månadshyra` : undefined}
        />
      </div>
      <div className="mb-1 flex items-start gap-3">
        <div className="flex-1">
          <Tabs<Tab>
            tabs={[
              { key: "now", label: "Lediga nu", count: data?.vacantNow.length },
              {
                key: "coming",
                label: "Blir lediga",
                count: data?.coming.length,
              },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        {properties.length > 1 && (
          <div className="w-56 shrink-0">
            <Select
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              aria-label="Fastighet"
            >
              <option value="">Alla fastigheter</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {data && rows?.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <div className="text-[14px] font-medium">
            {tab === "now" ? "Inga lediga objekt" : "Inga objekt blir lediga"}
          </div>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
            {tab === "now"
              ? "Alla aktiva objekt har ett gällande avtal."
              : "Inget avtal är uppsagt eller tidsbestämt utan att ett nytt avtal tar vid."}
          </p>
        </Card>
      ) : tab === "now" ? (
        <Table
          head={[
            "Objekt",
            ...(active ? [] : ["Bolag"]),
            "Typ",
            "Ledigt sedan",
            "Dagar",
            "Hyra/mån",
            "Förlorad hyra",
            "Intressenter",
            "",
          ]}
          empty="Laddar…"
        >
          {rows?.map((v) => (
            <tr key={v.objectId} className="hover:bg-subtle/60">
              <ObjectCell v={v} />
              {!active && <Td className="text-ink-2">{v.companyName}</Td>}
              <Td className="text-ink-2">
                {OBJECT_TYPE_LABEL[v.type] ?? v.type}
              </Td>
              <Td className="tabular text-ink-2">{v.vacantFrom}</Td>
              <Td className="tabular" sortValue={v.daysVacant}>
                {v.daysVacant}
              </Td>
              <Td className="tabular text-right">{fmtOre(v.monthlyRentOre)}</Td>
              <Td className="tabular text-right" sortValue={v.lostOre}>
                {v.monthlyRentOre ? (
                  fmtOre(v.lostOre)
                ) : (
                  <span className="text-ink-3">Hyra saknas</span>
                )}
              </Td>
              <InterestCell v={v} onOpen={() => setMatching(v)} />
              <Td className="text-right">
                {v.nextTenant ? (
                  <Badge tone="good">{`Uthyrt från ${addDay(v.vacantUntil)}`}</Badge>
                ) : v.offers ? (
                  <Badge tone="warn">{`${v.offers} erbjudna`}</Badge>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      ) : (
        <Table
          head={[
            "Objekt",
            ...(active ? [] : ["Bolag"]),
            "Typ",
            "Ledigt från",
            "Om dagar",
            "Flyttar",
            "Hyra/mån",
            "Intressenter",
            "",
          ]}
          empty="Laddar…"
        >
          {rows?.map((v) => (
            <tr key={v.objectId} className="hover:bg-subtle/60">
              <ObjectCell v={v} />
              {!active && <Td className="text-ink-2">{v.companyName}</Td>}
              <Td className="text-ink-2">
                {OBJECT_TYPE_LABEL[v.type] ?? v.type}
              </Td>
              <Td className="tabular text-ink-2">{v.vacantFrom}</Td>
              <Td className="tabular" sortValue={v.daysUntilVacant}>
                {v.daysUntilVacant}
              </Td>
              <Td className="text-ink-2">
                {v.currentContractId ? (
                  <Link
                    href={`/avtal/${v.currentContractId}`}
                    className="hover:underline"
                  >
                    {v.leavingTenant ?? "Avtal"}
                  </Link>
                ) : (
                  "–"
                )}
              </Td>
              <Td className="tabular text-right">{fmtOre(v.monthlyRentOre)}</Td>
              <InterestCell v={v} onOpen={() => setMatching(v)} />
              <Td className="text-right">
                {v.nextTenant ? (
                  <Badge tone="good">{`Uthyrt från ${addDay(v.vacantUntil)}`}</Badge>
                ) : v.status === "notice" ? (
                  <Badge tone="warn">Uppsagt</Badge>
                ) : (
                  <Badge>Avtalet löper ut</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <MatchesDialog
        vacancy={matching}
        onClose={() => setMatching(null)}
        onChanged={load}
        canManage={canManage}
      />
    </>
  );
}

function ObjectCell({ v }: { v: Vacancy }) {
  return (
    <Td className="font-medium">
      <Link href={`/objekt/${v.objectId}`} className="hover:underline">
        {v.propertyName} {v.objectNr}
      </Link>
      <div className="text-[12px] font-normal text-ink-3">
        {[
          v.rooms ? `${v.rooms} rum` : null,
          v.areaM2 ? `${v.areaM2} m²` : null,
          v.addressLine,
        ]
          .filter(Boolean)
          .join(" · ") || " "}
      </div>
    </Td>
  );
}

function InterestCell({ v, onOpen }: { v: Vacancy; onOpen: () => void }) {
  return (
    <Td sortValue={v.interested}>
      {v.interested ? (
        <button
          className="font-medium text-accent hover:underline"
          onClick={onOpen}
        >
          {v.interested} passar
        </button>
      ) : (
        <span className="text-ink-3">Ingen</span>
      )}
    </Td>
  );
}

function addDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
