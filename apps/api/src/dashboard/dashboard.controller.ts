import { Controller, Get } from '@nestjs/common';
import { today } from '../common/money';
import { attentionItems } from '../contracts/attention';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext } from '../auth/request-context';
import { DASHBOARD_EXTRAS, DashboardExtra } from './extras';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Startsidan: nyckeltal för valt bolag eller hela koncernen. Allt räknas fram
 * vid varje anrop ur objekt, avtal, fakturor och inbetalningar, så att talen
 * alltid stämmer med listorna de länkar till.
 */
@Controller('dashboard')
export class DashboardController {
  @Get()
  show(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

      // Uthyrning: antal objekt per status och hyresvärde för lediga objekt
      const [occ] = await q(
        `select count(*)::int as objects,
                count(*) filter (where st.status in ('occupied','notice'))::int as let,
                count(*) filter (where st.status = 'notice')::int as notice,
                count(*) filter (where st.status = 'upcoming')::int as upcoming,
                count(*) filter (where st.status = 'vacant')::int as vacant,
                coalesce(sum(cur.monthly_rent_ore) filter (where st.status in ('vacant','upcoming')), 0)::float as "vacantRentOre",
                coalesce(sum(o.area_m2), 0)::float as "areaM2",
                coalesce(sum(o.area_m2) filter (where st.status in ('occupied','notice')), 0)::float as "letAreaM2"
         from rental_object o
         left join rental_object_status st on st.object_id = o.id
         left join rental_object_current cur on cur.object_id = o.id
         where o.active`,
      );

      // Avtalad hyra i dag enligt avtalens hyresrader, exklusive moms
      const [rent] = await q(
        `select coalesce(sum(l.amount_ore), 0)::float as "monthlyOre",
                coalesce(sum(round(l.amount_ore * l.vat_rate_bp / 10000.0)), 0)::float as "monthlyVatOre",
                count(distinct k.id)::int as contracts
         from contract_line l join contract k on k.id = l.contract_id
         where k.status in ('active','terminated') and k.start_date <= current_date
           and (k.end_date is null or k.end_date >= current_date)
           and l.valid_from <= current_date and (l.valid_to is null or l.valid_to >= current_date)`,
      );

      // Uthyrning per fastighet, lägst uthyrningsgrad först
      const properties = await q(
        `select p.id, p.name, cmp.name as "companyName",
                count(o.id)::int as objects,
                count(o.id) filter (where st.status in ('occupied','notice'))::int as let,
                coalesce(sum(cur.monthly_rent_ore) filter (where st.status in ('vacant','upcoming')), 0)::float as "vacantRentOre"
         from property p
         join company cmp on cmp.id = p.company_id
         join rental_object o on o.property_id = p.id and o.active
         left join rental_object_status st on st.object_id = o.id
         left join rental_object_current cur on cur.object_id = o.id
         group by p.id, p.name, cmp.name
         order by (count(o.id) filter (where st.status in ('occupied','notice')))::float / greatest(count(o.id), 1), p.name`,
      );

      // Kundfordringar: obetalt, förfallet och åldersanalys på det förfallna
      const [recv] = await q(
        `select coalesce(sum(b.balance_ore), 0)::float as "openOre",
                count(*)::int as "openCount",
                coalesce(sum(b.balance_ore) filter (where i.due_date < current_date), 0)::float as "overdueOre",
                count(*) filter (where i.due_date < current_date)::int as "overdueCount",
                count(distinct i.customer_id) filter (where i.due_date < current_date)::int as "overdueCustomers",
                coalesce(sum(b.balance_ore) filter (where i.due_date >= current_date), 0)::float as "notDueOre",
                coalesce(sum(b.balance_ore) filter (where i.due_date < current_date and i.due_date >= current_date - 30), 0)::float as "d1_30",
                coalesce(sum(b.balance_ore) filter (where i.due_date < current_date - 30 and i.due_date >= current_date - 60), 0)::float as "d31_60",
                coalesce(sum(b.balance_ore) filter (where i.due_date < current_date - 60 and i.due_date >= current_date - 90), 0)::float as "d61_90",
                coalesce(sum(b.balance_ore) filter (where i.due_date < current_date - 90), 0)::float as "d90"
         from invoice i join invoice_balance b on b.invoice_id = i.id
         where i.status = 'issued' and b.balance_ore > 0`,
      );

      // Fakturerat och inbetalt per månad, de senaste tolv månaderna
      const months = await q(
        `with m as (
           select generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month')::date as month
         )
         select to_char(m.month, 'YYYY-MM') as month,
                coalesce((select sum(i.total_ore) from invoice i
                          where i.status = 'issued' and date_trunc('month', i.invoice_date) = m.month), 0)::float as "invoicedOre",
                coalesce((select sum(p.amount_ore) from payment p
                          where date_trunc('month', p.payment_date) = m.month), 0)::float as "paidOre"
         from m order by m.month`,
      );

      // Inbetalningar denna och förra månaden
      const [pay] = await q(
        `select coalesce(sum(amount_ore) filter (where date_trunc('month', payment_date) = date_trunc('month', current_date)), 0)::float as "thisMonthOre",
                count(*) filter (where date_trunc('month', payment_date) = date_trunc('month', current_date))::int as "thisMonthCount",
                coalesce(sum(amount_ore) filter (where date_trunc('month', payment_date) = date_trunc('month', current_date) - interval '1 month'), 0)::float as "lastMonthOre"
         from payment
         where payment_date >= date_trunc('month', current_date) - interval '1 month'`,
      );

      // Det som ska betalas in denna månad: avier och fakturor med förfallodag i månaden
      const [dueMonth] = await q(
        `select coalesce(sum(i.total_ore), 0)::float as "dueOre",
                coalesce(sum(b.balance_ore) filter (where b.balance_ore > 0), 0)::float as "stillOpenOre"
         from invoice i join invoice_balance b on b.invoice_id = i.id
         where i.status = 'issued' and i.kind <> 'credit_note'
           and date_trunc('month', i.due_date) = date_trunc('month', current_date)`,
      );

      // Inbetalningar som inte hittat sin faktura
      const [unmatched] = await q(
        `select count(*)::int as count, coalesce(sum(amount_ore), 0)::float as "amountOre"
         from bank_transaction where status = 'unmatched'`,
      );

      // Avtal som slutar inom 90 dagar och uppsägningar som kommit in senaste 30 dagarna
      const ending = await q(
        `select k.id as "contractId", k.contract_nr as "contractNr", k.end_date::text as "endDate", k.status,
                c.name as "customerName", cmp.name as "companyName",
                coalesce((select string_agg(o.object_nr, ', ' order by o.object_nr) from contract_object x
                   join rental_object o on o.id = x.object_id where x.contract_id = k.id), '') as objects
         from contract k join customer c on c.id = k.customer_id join company cmp on cmp.id = k.company_id
         where k.end_date between current_date and current_date + 90
           and (k.status = 'terminated' or (k.status = 'active' and k.extension_months is null))
         order by k.end_date`,
      );
      const notices = await q(
        `select k.id as "contractId", k.contract_nr as "contractNr", k.termination_received::text as "receivedDate",
                k.end_date::text as "endDate", k.terminated_by as "terminatedBy", c.name as "customerName",
                coalesce((select string_agg(o.object_nr, ', ' order by o.object_nr) from contract_object x
                   join rental_object o on o.id = x.object_id where x.contract_id = k.id), '') as objects
         from contract k join customer c on c.id = k.customer_id
         where k.status = 'terminated' and k.termination_received >= current_date - 30
         order by k.termination_received desc`,
      );
      const attention = await attentionItems(client);

      // Per bolag, när fler än ett bolag visas
      const companies = await q(
        `select cmp.id, cmp.name,
                (select count(*) from rental_object o where o.company_id = cmp.id and o.active)::int as objects,
                (select count(*) from rental_object o join rental_object_status st on st.object_id = o.id
                  where o.company_id = cmp.id and o.active and st.status in ('occupied','notice'))::int as let,
                (select coalesce(sum(l.amount_ore), 0) from contract_line l join contract k on k.id = l.contract_id
                  where k.company_id = cmp.id and k.status in ('active','terminated') and k.start_date <= current_date
                    and (k.end_date is null or k.end_date >= current_date)
                    and l.valid_from <= current_date and (l.valid_to is null or l.valid_to >= current_date))::float as "monthlyRentOre",
                (select coalesce(sum(b.balance_ore), 0) from invoice i join invoice_balance b on b.invoice_id = i.id
                  where i.company_id = cmp.id and i.status = 'issued' and b.balance_ore > 0)::float as "openOre",
                (select coalesce(sum(b.balance_ore), 0) from invoice i join invoice_balance b on b.invoice_id = i.id
                  where i.company_id = cmp.id and i.status = 'issued' and b.balance_ore > 0 and i.due_date < current_date)::float as "overdueOre",
                (select count(*) from bank_transaction t where t.company_id = cmp.id and t.status = 'unmatched')::int as unmatched
         from company cmp order by cmp.name`,
      );

      const extras: DashboardExtra[] = [];
      for (const provider of DASHBOARD_EXTRAS) {
        const e = await provider(client);
        if (e) extras.push(e);
      }

      const objects = n(occ.objects);
      const letCount = n(occ.let);
      const contracted = n(rent.monthlyOre);
      const vacantRent = n(occ.vacantRentOre);
      return {
        today: today(),
        occupancy: {
          objects,
          let: letCount,
          notice: n(occ.notice),
          upcoming: n(occ.upcoming),
          vacant: n(occ.vacant),
          byCount: objects ? letCount / objects : null,
          byValue: contracted + vacantRent > 0 ? contracted / (contracted + vacantRent) : null,
          vacantRentOre: vacantRent,
          areaM2: n(occ.areaM2),
          letAreaM2: n(occ.letAreaM2),
        },
        rent: { monthlyOre: contracted, monthlyVatOre: n(rent.monthlyVatOre), contracts: n(rent.contracts) },
        properties: properties.map((p) => ({ ...p, occupancy: p.objects ? p.let / p.objects : null })),
        receivables: {
          openOre: n(recv.openOre),
          openCount: n(recv.openCount),
          overdueOre: n(recv.overdueOre),
          overdueCount: n(recv.overdueCount),
          overdueCustomers: n(recv.overdueCustomers),
          aging: [
            { key: 'notDue', label: 'Ej förfallet', amountOre: n(recv.notDueOre) },
            { key: 'd1_30', label: '1–30 dagar', amountOre: n(recv.d1_30) },
            { key: 'd31_60', label: '31–60 dagar', amountOre: n(recv.d31_60) },
            { key: 'd61_90', label: '61–90 dagar', amountOre: n(recv.d61_90) },
            { key: 'd90', label: 'Över 90 dagar', amountOre: n(recv.d90) },
          ],
        },
        payments: {
          thisMonthOre: n(pay.thisMonthOre),
          thisMonthCount: n(pay.thisMonthCount),
          lastMonthOre: n(pay.lastMonthOre),
          dueThisMonthOre: n(dueMonth.dueOre),
          dueThisMonthOpenOre: n(dueMonth.stillOpenOre),
        },
        months,
        unmatched: { count: n(unmatched.count), amountOre: n(unmatched.amountOre) },
        contracts: {
          ending,
          notices,
          attention: attention.slice(0, 8),
          attentionCount: attention.length,
          attentionHigh: attention.filter((a) => a.severity === 'high').length,
        },
        companies: companies.map((c) => ({ ...c, occupancy: c.objects ? c.let / c.objects : null })),
        extras,
      };
    });
  }
}
