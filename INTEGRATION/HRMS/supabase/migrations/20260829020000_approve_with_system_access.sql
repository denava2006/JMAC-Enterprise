-- Apply a position's system access in the same transaction that approves it.
--
-- This is the whole point of putting eligibility on the change request rather
-- than writing it separately from the client: approve and both land, reject and
-- neither does. There is no ordering in which a rejected position leaves an
-- entitlement row behind, because rejection never reaches this code.
--
-- The body is Phase 8's approve_change_request with two additions, and nothing
-- else changed:
--   1. the generic INSERT now returns the new row's id, so a create knows what
--      it just made (all three permitted target tables have an id column);
--   2. after the write, a positions request applies r.system_access through the
--      shared writer.
--
-- CREATE OR REPLACE does not restore grants, and this project's default
-- privileges re-grant new routines to anon -- ACL incident #5. The revokes at
-- the bottom are re-issued for that reason and are not redundant.

create or replace function public.approve_change_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r public.change_requests;
  col_list text;
  _target_id uuid;
begin
  if not public.is_hr_manager_or_admin() then
    raise exception 'Only an HR Manager can approve changes.';
  end if;

  select * into r from public.change_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if r.status <> 'pending' then
    raise exception 'ALREADY_REVIEWED';
  end if;

  -- A manager approving their own submission would defeat the review, so the
  -- author and the reviewer must be different people.
  if r.requested_by = auth.uid() then
    raise exception 'You cannot approve a change you submitted yourself.';
  end if;

  _target_id := r.target_id;

  if r.operation = 'delete' then
    execute format('delete from public.%I where id = $1', r.target_table) using r.target_id;
  else
    -- Only the columns actually present in the payload are written, so
    -- everything else keeps its column default (on create) or its current
    -- value (on update). jsonb_populate_record does the type coercion, which
    -- matters for non-scalar columns like work_schedules.working_days
    -- (smallint[]) that a plain ->> text cast would mangle.
    select string_agg(quote_ident(key), ', ') into col_list
    from jsonb_object_keys(r.payload) as key;

    if col_list is null then
      raise exception 'EMPTY_PAYLOAD';
    end if;

    if r.operation = 'create' then
      execute format(
        'insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning id',
        r.target_table, col_list, col_list, r.target_table
      ) into _target_id using r.payload;
    else
      execute format(
        'update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where id = $2',
        r.target_table, col_list, col_list, r.target_table
      ) using r.payload, r.target_id;
    end if;
  end if;

  -- Eligibility rides with the position, in this transaction. A delete carries
  -- no access, and position_system_roles cascades on the position anyway.
  if r.target_table = 'positions' and r.operation <> 'delete' and r.system_access is not null then
    perform public.apply_position_system_access(_target_id, r.system_access);
  end if;

  update public.change_requests
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_request_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'Change Request Approved', r.target_table, coalesce(_target_id, p_request_id), r.payload);
end;
$fn$;

revoke all on function public.approve_change_request(uuid) from public, anon;
grant execute on function public.approve_change_request(uuid) to authenticated;
