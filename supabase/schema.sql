-- Friends Included. Run once in the project's Supabase SQL editor.
-- Only employees are seeded. No practice or assessment transactions are inserted.
create table if not exists public.fi_employees (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('sales','expense','manager'))
);
insert into public.fi_employees(id,name,kind) values
 ('richard','Richard “Call Me Dick” Darling','sales'),
 ('anastasia','Anastasia Ferrari','sales'),
 ('jean_claude','Jean-Claude Bērziņš','sales'),
 ('kevin','Kevin von Whatever','expense'),
 ('svetlana','Svetlana de Monte Carlo','manager')
on conflict (id) do update set name=excluded.name,kind=excluded.kind;

create table if not exists public.fi_telegram_accounts (
  telegram_user_id text primary key check (telegram_user_id ~ '^[0-9]+$'),
  chat_id text not null,
  first_name text not null default '',
  employee_id text references public.fi_employees(id),
  started_at timestamptz not null default now(),
  linked_at timestamptz
);
create table if not exists public.fi_transactions (
  reference text primary key check (reference ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  kind text not null check (kind in ('sale','expense')),
  submitted_at timestamptz not null default now(),
  submitted_by text not null references public.fi_employees(id),
  source text not null check (source in ('website','telegram')),
  telegram_update_id bigint unique,
  origin_chat_id text,
  customer text,
  project text check (project in ('A','B')),
  description text not null check (length(trim(description)) between 1 and 600),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000000),
  proposed_split_bp integer[],
  final_split_bp integer[],
  commission_pool_cents bigint not null default 0,
  commission_cents bigint[] not null default array[0,0,0]::bigint[],
  category text check (category in ('Materials','Travel','Other')),
  proposed_allocation text check (proposed_allocation in ('A','B','Company overhead')),
  final_allocation text check (final_allocation in ('A','B','Company overhead')),
  status text not null check (status in ('pending','approved','awaiting_allocation','allocated')),
  version integer not null default 1,
  decision_at timestamptz,
  decision_by text references public.fi_employees(id),
  check ((kind='sale' and project is not null and customer is not null and length(trim(customer)) between 1 and 150 and proposed_split_bp is not null and category is null and proposed_allocation is null and status in ('pending','approved')) or
         (kind='expense' and category is not null and proposed_allocation is not null and project is null and customer is null and proposed_split_bp is null and status in ('awaiting_allocation','allocated'))),
  check (kind<>'sale' or (cardinality(proposed_split_bp)=3 and array_position(proposed_split_bp,null) is null and proposed_split_bp[1] between 0 and 10000 and proposed_split_bp[2] between 0 and 10000 and proposed_split_bp[3] between 0 and 10000 and proposed_split_bp[1]+proposed_split_bp[2]+proposed_split_bp[3]=10000)),
  check (kind<>'sale' or (status='pending' and final_split_bp is null and commission_pool_cents=0 and commission_cents=array[0,0,0]::bigint[]) or (status='approved' and final_split_bp is not null and cardinality(final_split_bp)=3 and array_position(final_split_bp,null) is null and final_split_bp[1] between 0 and 10000 and final_split_bp[2] between 0 and 10000 and final_split_bp[3] between 0 and 10000 and final_split_bp[1]+final_split_bp[2]+final_split_bp[3]=10000)),
  check (kind<>'expense' or (status='awaiting_allocation' and final_allocation is null) or (status='allocated' and final_allocation is not null))
);
create table if not exists public.fi_outbox (
  id bigint generated always as identity primary key,
  reference text not null references public.fi_transactions(reference) on delete cascade,
  version integer not null,
  channel text not null check (channel in ('sheets','telegram')),
  event text not null check (event in ('submission','decision')),
  destination text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','no_recipient')),
  attempts integer not null default 0,
  last_error text,
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(reference,version,channel)
);
create index if not exists fi_outbox_pending on public.fi_outbox(status,created_at);
create table if not exists public.fi_settings (
  id integer primary key check(id=1),
  fail_sheets boolean not null default false,
  fail_telegram boolean not null default false
);
insert into public.fi_settings(id) values(1) on conflict do nothing;

-- RLS has no browser policies: only the backend service-role key may access data.
alter table public.fi_employees enable row level security;
alter table public.fi_telegram_accounts enable row level security;
alter table public.fi_transactions enable row level security;
alter table public.fi_outbox enable row level security;
alter table public.fi_settings enable row level security;
revoke all on public.fi_employees,public.fi_telegram_accounts,public.fi_transactions,public.fi_outbox,public.fi_settings from anon,authenticated;
grant all on public.fi_employees,public.fi_telegram_accounts,public.fi_transactions,public.fi_outbox,public.fi_settings to service_role;
grant usage,select on sequence public.fi_outbox_id_seq to service_role;

create or replace function public.fi_queue(p_record public.fi_transactions,p_event text)
returns void language plpgsql set search_path='' as $$
declare destination text;
begin
  destination := p_record.origin_chat_id;
  if destination is null and p_record.source='website' then
    select chat_id into destination from public.fi_telegram_accounts where employee_id=p_record.submitted_by order by linked_at desc nulls last limit 1;
  end if;
  insert into public.fi_outbox(reference,version,channel,event,payload)
  values(p_record.reference,p_record.version,'sheets',p_event,to_jsonb(p_record));
  insert into public.fi_outbox(reference,version,channel,event,destination,payload,status)
  values(p_record.reference,p_record.version,'telegram',p_event,destination,to_jsonb(p_record),case when destination is null then 'no_recipient' else 'pending' end);
end $$;

create or replace function public.fi_submit(p_role text,p_record jsonb,p_source text default 'website',p_chat_id text default null,p_update_id bigint default null)
returns jsonb language plpgsql set search_path='' as $$
declare r public.fi_transactions; employee_kind text; destination text; input_kind text;
begin
  select kind into employee_kind from public.fi_employees where id=p_role;
  input_kind := p_record->>'kind';
  if employee_kind is null or (input_kind='sale' and employee_kind<>'sales') or (input_kind='expense' and employee_kind<>'expense') then raise exception using message='This role cannot submit this transaction.',errcode='42501'; end if;
  if p_source not in ('website','telegram') then raise exception 'Invalid source.'; end if;
  if p_source='telegram' then
    if p_chat_id is null or p_update_id is null then raise exception 'Telegram origin is required.'; end if;
    -- A retried delivery of the identical Telegram update is idempotent.
    select * into r from public.fi_transactions where telegram_update_id=p_update_id;
    if found then return jsonb_build_object('transaction',to_jsonb(r),'unchanged',true); end if;
    destination := p_chat_id;
  else
    select chat_id into destination from public.fi_telegram_accounts where employee_id=p_role order by linked_at desc nulls last limit 1;
  end if;
  if input_kind='sale' then
    insert into public.fi_transactions(reference,kind,submitted_by,source,telegram_update_id,origin_chat_id,customer,project,description,amount_cents,proposed_split_bp,status)
    values(p_record->>'reference','sale',p_role,p_source,p_update_id,destination,p_record->>'customer',p_record->>'project',p_record->>'description',(p_record->>'amount_cents')::bigint,
      array(select jsonb_array_elements_text(p_record->'proposed_split_bp'))::integer[],'pending') returning * into r;
  elsif input_kind='expense' then
    insert into public.fi_transactions(reference,kind,submitted_by,source,telegram_update_id,origin_chat_id,description,amount_cents,category,proposed_allocation,final_allocation,status)
    values(p_record->>'reference','expense',p_role,p_source,p_update_id,destination,p_record->>'description',(p_record->>'amount_cents')::bigint,p_record->>'category',p_record->>'proposed_allocation',
      case when p_record->>'proposed_allocation'='Company overhead' then 'Company overhead' else null end,
      case when p_record->>'proposed_allocation'='Company overhead' then 'allocated' else 'awaiting_allocation' end) returning * into r;
  else raise exception 'Invalid transaction kind.'; end if;
  perform public.fi_queue(r,'submission');
  return jsonb_build_object('transaction',to_jsonb(r),'unchanged',false);
exception when unique_violation then
  if p_source='telegram' and p_update_id is not null then
    select * into r from public.fi_transactions where telegram_update_id=p_update_id;
    if found then return jsonb_build_object('transaction',to_jsonb(r),'unchanged',true); end if;
  end if;
  raise exception using message='This reference already exists. Use a unique reference.',errcode='23505';
end $$;

create or replace function public.fi_decide(p_role text,p_reference text,p_split integer[] default null,p_allocation text default null)
returns jsonb language plpgsql set search_path='' as $$
declare r public.fi_transactions; pool bigint; shares bigint[]; residual bigint; largest integer:=1; i integer;
begin
  if p_role is distinct from 'svetlana' then raise exception using message='Only Svetlana can approve or allocate transactions.',errcode='42501'; end if;
  select * into r from public.fi_transactions where reference=p_reference for update;
  if not found then raise exception 'Transaction not found.'; end if;
  if r.status in ('approved','allocated') then return jsonb_build_object('transaction',to_jsonb(r),'unchanged',true); end if;
  if r.kind='sale' then
    if p_allocation is not null or p_split is null or cardinality(p_split) is distinct from 3 or p_split[1] is null or p_split[2] is null or p_split[3] is null or p_split[1]<0 or p_split[2]<0 or p_split[3]<0 or p_split[1]>10000 or p_split[2]>10000 or p_split[3]>10000 or p_split[1]+p_split[2]+p_split[3]<>10000 then raise exception using message='Commission shares must be between 0% and 100% and total exactly 100%.'; end if;
    pool := (r.amount_cents+5)/10;
    shares := array[((pool*p_split[1]+5000)/10000),((pool*p_split[2]+5000)/10000),((pool*p_split[3]+5000)/10000)];
    for i in 2..3 loop if p_split[i]>p_split[largest] then largest:=i; end if; end loop;
    residual:=pool-shares[1]-shares[2]-shares[3]; shares[largest]:=shares[largest]+residual;
    update public.fi_transactions set final_split_bp=p_split,commission_pool_cents=pool,commission_cents=shares,status='approved',decision_at=now(),decision_by=p_role,version=version+1 where reference=p_reference returning * into r;
  else
    if p_split is not null or p_allocation is null or p_allocation not in ('A','B','Company overhead') then raise exception 'Select a final allocation.'; end if;
    update public.fi_transactions set final_allocation=p_allocation,status='allocated',decision_at=now(),decision_by=p_role,version=version+1 where reference=p_reference returning * into r;
  end if;
  perform public.fi_queue(r,'decision');
  return jsonb_build_object('transaction',to_jsonb(r),'unchanged',false);
end $$;

create or replace function public.fi_link_telegram(p_role text,p_user_id text,p_employee text)
returns void language plpgsql set search_path='' as $$
begin
  if p_role is distinct from 'svetlana' then raise exception using message='Only Svetlana can link Telegram users.',errcode='42501'; end if;
  if p_employee is not null and not exists(select 1 from public.fi_employees where id=p_employee) then raise exception 'Unknown employee.'; end if;
  update public.fi_telegram_accounts set employee_id=p_employee,linked_at=now() where telegram_user_id=p_user_id;
  if not found then raise exception 'This Telegram user must first start the bot in a private chat.'; end if;
end $$;

-- Claim only one active Sheets job at once. It serializes reference upserts.
create or replace function public.fi_claim_outbox(p_channel text)
returns jsonb language plpgsql set search_path='' as $$
declare job public.fi_outbox;
begin
  perform pg_advisory_xact_lock(case when p_channel='sheets' then 440001 else 440002 end);
  update public.fi_outbox set status='failed',last_error='Delivery interrupted; safe to retry.',lease_until=null,lease_token=null where channel=p_channel and status='processing' and lease_until<now();
  if p_channel='sheets' and exists(select 1 from public.fi_outbox where channel='sheets' and status='processing' and lease_until>now()) then return null; end if;
  select * into job from public.fi_outbox where channel=p_channel and status='pending' order by id for update skip locked limit 1;
  if not found then return null; end if;
  update public.fi_outbox set status='processing',attempts=attempts+1,lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid(),last_error=null where id=job.id returning * into job;
  return to_jsonb(job);
end $$;
create or replace function public.fi_finish_outbox(p_id bigint,p_token uuid,p_success boolean,p_error text default null)
returns void language plpgsql set search_path='' as $$
declare finished public.fi_outbox;
begin
  update public.fi_outbox set status=case when p_success then 'sent' else 'failed' end,last_error=case when p_success then null else left(p_error,500) end,completed_at=case when p_success then now() else null end,lease_until=null,lease_token=null where id=p_id and lease_token=p_token returning * into finished;
  -- A successful current-row upsert also fulfills any interrupted older copy.
  -- Telegram events stay independent: a later decision cannot erase a failed confirmation.
  if found and p_success and finished.channel='sheets' then
    update public.fi_outbox set status='sent',last_error=null,completed_at=now(),lease_until=null,lease_token=null where reference=finished.reference and channel='sheets' and version<=finished.version and status in ('pending','failed');
  end if;
end $$;
create or replace function public.fi_retry(p_role text,p_reference text,p_channel text)
returns integer language plpgsql set search_path='' as $$
declare changed integer;
begin
  if p_role is distinct from 'svetlana' then raise exception using message='Only Svetlana can retry delivery.',errcode='42501'; end if;
  if p_channel not in ('sheets','telegram') then raise exception 'Unknown delivery channel.'; end if;
  update public.fi_outbox set status='pending',last_error=null,lease_until=null,lease_token=null where reference=p_reference and channel=p_channel and (status='failed' or (status='processing' and lease_until<now()));
  get diagnostics changed=row_count;
  return changed;
end $$;

-- Functions are server-only, never anonymously callable through PostgREST.
revoke all on function public.fi_queue(public.fi_transactions,text) from public,anon,authenticated;
revoke all on function public.fi_submit(text,jsonb,text,text,bigint) from public,anon,authenticated;
revoke all on function public.fi_decide(text,text,integer[],text) from public,anon,authenticated;
revoke all on function public.fi_link_telegram(text,text,text) from public,anon,authenticated;
revoke all on function public.fi_claim_outbox(text) from public,anon,authenticated;
revoke all on function public.fi_finish_outbox(bigint,uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.fi_retry(text,text,text) from public,anon,authenticated;
grant execute on function public.fi_queue(public.fi_transactions,text),public.fi_submit(text,jsonb,text,text,bigint),public.fi_decide(text,text,integer[],text),public.fi_link_telegram(text,text,text),public.fi_claim_outbox(text),public.fi_finish_outbox(bigint,uuid,boolean,text),public.fi_retry(text,text,text) to service_role;
