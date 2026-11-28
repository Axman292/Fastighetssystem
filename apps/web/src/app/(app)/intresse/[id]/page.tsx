"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ConvertDialog,
  fromRegistration,
  RegistrationDialog,
} from "@/components/interest";
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorNote,
  PageHeader,
  Select,
  Table,
  Td,
  formatDateTime,
} from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { fmtOre, OBJECT_TYPE_LABEL } from "@/lib/format";
import { useSession } from "@/lib/session";
import {
  INTEREST_STATUS,
  OFFER_STATUS,
  RegistrationDetail,
} from "@/lib/vacancies";

export default function RegistrationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { active, can, version } = useSession();
  const [r, setR] = useState<RegistrationDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const canManage = !!active && can("interest.manage");

  const load = () =>
    api<RegistrationDetail>(`/interests/${id}`)
      .then(setR)
      .catch((e: ApiError) => setErr(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]);
  const initial = useMemo(() => (r ? fromRegistration(r) : undefined), [r]);

  if (!r) return <ErrorNote message={err} />;
  const st = INTEREST_STATUS[r.status];
  const offered = new Set(r.offers.map((o) => o.objectId));
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const types = r.objectTypes.length
    ? r.objectTypes.map((t) => OBJECT_TYPE_LABEL[t] ?? t).join(", ")
    : "Alla typer";

  return (
    <>
      <div className="mb-2 text-[13px] text-ink-3">
        <Link href="/intresse" className="hover:text-ink">
          Intresselista
        </Link>{" "}
        / {r.registrationNr}
      </div>
      <PageHeader
        title={r.name}
        description={`Anmäld ${r.createdAt.slice(0, 10)}${r.source === "form" ? " via formuläret" : ""}. Senaste kontakt ${r.lastActivityAt.slice(0, 10)}.`}
        actions={
          canManage ? (
            <>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                Ta bort
              </Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Ändra
              </Button>
            </>
          ) : undefined
        }
      />
      <ErrorNote message={err} />
      <div className="mb-6 grid grid-cols-3 gap-3">
        <Card className="px-4 py-3.5">
          <div className="text-[12px] text-ink-3">Status</div>
          <div className="mt-1.5 flex items-center gap-2">
            <Badge tone={st?.tone}>{st?.label ?? r.status}</Badge>
            {canManage && r.status !== "converted" && (
              <div className="w-40">
                <Select
                  className="h-7"
                  value={r.status}
                  aria-label="Ändra status"
                  onChange={(e) =>
                    act(() =>
                      api(`/interests/${r.id}`, {
                        method: "PATCH",
                        body: { status: e.target.value },
                      }),
                    )
                  }
                >
                  {Object.entries(INTEREST_STATUS)
                    .filter(([k]) => k !== "converted")
                    .map(([k, s]) => (
                      <option key={k} value={k}>
                        {s.label}
                      </option>
                    ))}
                </Select>
              </div>
            )}
          </div>
          {r.customerId && (
            <div className="mt-2 text-[13px]">
              <Link
                href={`/kunder/${r.customerId}`}
                className="text-accent hover:underline"
              >
                Hyresgäst {r.customerName}
              </Link>
              {r.contractId && (
                <>
                  {" · "}
                  <Link
                    href={`/avtal/${r.contractId}`}
                    className="text-accent hover:underline"
                  >
                    Avtal {r.contractNr}
                  </Link>
                </>
              )}
            </div>
          )}
        </Card>
        <Card className="px-4 py-3.5 text-[13px]">
          <div className="text-[12px] text-ink-3">Kontakt</div>
          <div className="mt-1 space-y-0.5">
            {r.contactPerson && <div>{r.contactPerson}</div>}
            {r.email && (
              <a
                href={`mailto:${r.email}`}
                className="block text-accent hover:underline"
              >
                {r.email}
              </a>
            )}
            {r.phone && <div className="tabular">{r.phone}</div>}
            {(r.addressLine || r.city) && (
              <div className="text-ink-2">
                {[
                  r.addressLine,
                  [r.postalCode, r.city].filter(Boolean).join(" "),
                ]
                  .filter(Boolean)
                  .join(", ")}
              </div>
            )}
          </div>
        </Card>
        <Card className="px-4 py-3.5 text-[13px]">
          <div className="text-[12px] text-ink-3">Söker</div>
          <div className="mt-1 space-y-0.5">
            <div>{types}</div>
            <div className="text-ink-2">
              {r.properties.length
                ? r.properties.map((p) => p.name).join(", ")
                : "Alla fastigheter"}
            </div>
            <div className="text-ink-2">
              {[
                r.minRooms ? `minst ${r.minRooms} rum` : null,
                r.minAreaM2 ? `minst ${r.minAreaM2} m²` : null,
                r.maxRentOre ? `högst ${fmtOre(r.maxRentOre)}/mån` : null,
                r.desiredFrom ? `inflytt från ${r.desiredFrom}` : null,
                r.householdSize ? `${r.householdSize} personer` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Inga fler önskemål"}
            </div>
          </div>
        </Card>
      </div>

      {(r.message || r.notes) && (
        <div className="mb-6 grid grid-cols-2 gap-3">
          {r.message && (
            <Card className="px-4 py-3.5 text-[13px]">
              <div className="text-[12px] text-ink-3">Meddelande</div>
              <p className="mt-1 whitespace-pre-wrap">{r.message}</p>
            </Card>
          )}
          {r.notes && (
            <Card className="px-4 py-3.5 text-[13px]">
              <div className="text-[12px] text-ink-3">Interna anteckningar</div>
              <p className="mt-1 whitespace-pre-wrap">{r.notes}</p>
            </Card>
          )}
        </div>
      )}

      {r.status !== "converted" && (
        <section className="mb-8">
          <h2 className="mb-1 text-[14px] font-semibold">
            Lediga objekt som passar
          </h2>
          <p className="mb-3 text-[13px] text-ink-2">
            Objekt som är lediga nu eller blir lediga och som stämmer med
            önskemålen.
          </p>
          <Table
            head={["Objekt", "Typ", "Ledigt från", "Hyra/mån", ""]}
            empty="Inget ledigt objekt passar just nu."
          >
            {r.matching.map((v) => (
              <tr key={v.objectId}>
                <Td className="font-medium">
                  <Link
                    href={`/objekt/${v.objectId}`}
                    className="hover:underline"
                  >
                    {v.propertyName} {v.objectNr}
                  </Link>
                  <div className="text-[12px] font-normal text-ink-3">
                    {[
                      v.rooms ? `${v.rooms} rum` : null,
                      v.areaM2 ? `${v.areaM2} m²` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || " "}
                  </div>
                </Td>
                <Td className="text-ink-2">
                  {OBJECT_TYPE_LABEL[v.type] ?? v.type}
                </Td>
                <Td className="tabular text-ink-2">
                  {v.vacantFrom}
                  {v.nextTenant && (
                    <div className="text-[12px] text-ink-3">{`uthyrt till ${v.nextTenant}`}</div>
                  )}
                </Td>
                <Td className="tabular">{fmtOre(v.monthlyRentOre)}</Td>
                <Td className="text-right">
                  {canManage && (
                    <div className="flex justify-end gap-1.5">
                      {!offered.has(v.objectId) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            act(() =>
                              api(`/interests/${r.id}/offers`, {
                                method: "POST",
                                body: { objectId: v.objectId },
                              }),
                            )
                          }
                        >
                          Erbjud
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => setConverting(v.objectId)}
                      >
                        Gör till hyresgäst
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-[14px] font-semibold">Erbjudanden</h2>
        <Table
          head={["Objekt", "Hyra/mån", "Erbjudet", "Anteckning", "Svar"]}
          empty="Inga objekt har erbjudits ännu."
        >
          {r.offers.map((o) => (
            <tr key={o.id}>
              <Td className="font-medium">
                <Link
                  href={`/objekt/${o.objectId}`}
                  className="hover:underline"
                >
                  {o.propertyName} {o.objectNr}
                </Link>
              </Td>
              <Td className="tabular">{fmtOre(o.monthlyRentOre)}</Td>
              <Td className="tabular text-ink-2">
                {formatDateTime(o.createdAt)}
              </Td>
              <Td className="text-ink-2">{o.note ?? "–"}</Td>
              <Td>
                {canManage && r.status !== "converted" ? (
                  <div className="w-32">
                    <Select
                      className="h-7"
                      value={o.status}
                      aria-label="Svar"
                      onChange={(e) =>
                        act(() =>
                          api(`/interests/${r.id}/offers/${o.id}`, {
                            method: "PATCH",
                            body: { status: e.target.value },
                          }),
                        )
                      }
                    >
                      {Object.entries(OFFER_STATUS).map(([k, s]) => (
                        <option key={k} value={k}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <Badge tone={OFFER_STATUS[o.status]?.tone}>
                    {OFFER_STATUS[o.status]?.label}
                  </Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      {r.consentAt && (
        <Card className="px-4 py-3.5 text-[12.5px] text-ink-2">
          <div className="font-medium text-ink">
            Samtycke lämnat {formatDateTime(r.consentAt)}
          </div>
          <p className="mt-1 whitespace-pre-wrap">{r.consentText}</p>
        </Card>
      )}

      <RegistrationDialog
        open={editing}
        onClose={() => setEditing(false)}
        initial={initial}
        id={r.id}
        onSaved={() => {
          setEditing(false);
          load();
        }}
      />
      <ConvertDialog
        open={!!converting}
        onClose={() => setConverting(null)}
        registration={r}
        objects={r.matching}
        objectId={converting ?? undefined}
      />
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Ta bort anmälan"
      >
        <p className="text-[13px] text-ink-2">
          Anmälan och erbjudandena tas bort, och personuppgifterna rensas ur
          revisionsloggen. Gör så här när någon återkallar sitt samtycke eller
          ber att bli borttagen. Det går inte att ångra.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(false)}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              try {
                await api(`/interests/${r.id}`, { method: "DELETE" });
                router.push("/intresse");
              } catch (e) {
                setErr((e as ApiError).message);
                setDeleting(false);
              }
            }}
          >
            Ta bort
          </Button>
        </div>
      </Dialog>
    </>
  );
}
