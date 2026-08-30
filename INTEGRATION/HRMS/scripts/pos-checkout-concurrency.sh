#!/usr/bin/env bash
# Two-session checkout concurrency test.
#
# The single-session contract test cannot show a double charge or a lost
# deduction: everything inside one transaction sees its own writes. This runs
# genuinely concurrent psql sessions against the same till and checks that
# money is taken once and stock leaves once.
#
#   bash scripts/pos-checkout-concurrency.sh
#
# Writes real, committed rows -- a double charge is only observable after a
# commit -- and removes them again at the end. Exits non-zero on any failure.

set -uo pipefail

DB=(docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres -tAq)
q() { "${DB[@]}" -c "$1"; }

fail() { echo "FAIL  $1"; FAILED=1; }
pass() { echo "PASS  $1"; }
FAILED=0

TAG="chk$(date +%s)"
ADMIN=$(q "select id from public.profiles where role='admin' and status='active' limit 1;")
BRANCH=$(q "select id from public.branches where is_active order by name limit 1;")
CATEGORY=$(q "select id from public.pos_product_categories where normalized_name='general';")
# Phase 9A: POS access requires a canonical employment record -- an active
# profile with role 'employee', linked to an active employee whose position is
# configured for the role. The demo accounts are IT Support and Sales Associate,
# so grabbing "the first employee profile" no longer works, and should not: that
# is precisely what this phase closed.
#
# This harness commits its fixtures (it races real sessions, so it cannot run
# inside a rolled-back transaction), so it mints a compliant till user and
# removes it again in cleanup.
STORE_OPS=$(q "select id from public.departments where name='Store Operations';")
CASHIER_POSITION=$(q "select id from public.positions where department_id='$STORE_OPS' and title='Cashier';")
if [ -z "$STORE_OPS" ] || [ -z "$CASHIER_POSITION" ]; then
  echo "FAIL  fixture: Store Operations / Cashier is missing (migration 20260828010000)"
  exit 1
fi

CASHIER_EMAIL="zz.concurrency.$(date +%s)@example.com"
CASHIER=$(q "
  with u as (
    insert into auth.users (id, email) values (gen_random_uuid(), '$CASHIER_EMAIL') returning id
  ), e as (
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    values ('ZZ', 'Concurrency', '$CASHIER_EMAIL', '$STORE_OPS', '$CASHIER_POSITION',
            'active', current_date)
    returning id
  )
  insert into public.profiles (id, employee_id, full_name, email, role, status)
  select u.id, e.id, 'ZZ Concurrency Till', '$CASHIER_EMAIL', 'employee', 'active' from u, e
  on conflict (id) do update set employee_id = excluded.employee_id, role = 'employee',
                                 status = 'active', full_name = excluded.full_name
  returning id;")
CASHIER_EMPLOYEE=$(q "select employee_id from public.profiles where id='$CASHIER';")

if [ -z "$ADMIN" ] || [ -z "$BRANCH" ] || [ -z "$CATEGORY" ] || [ -z "$CASHIER" ]; then
  echo "FAIL  fixture: need an active admin, an active branch, the General category and an employee"
  exit 1
fi

echo "=== setting up committed fixtures ==="
PRODUCT=$(q "insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
             values ('ZZ Checkout $TAG', '$CATEGORY', 100, 0, 'active') returning id;")
q "insert into public.pos_branch_products (branch_id, product_id) values ('$BRANCH','$PRODUCT');" > /dev/null

# `do nothing`, not `do update`: an upsert would return the id of a row that
# already existed, and the cleanup below would then delete somebody's real
# assignment. An empty result means the cashier was already assigned, which is
# fine to use and must be left alone.
ASSIGNMENT=$(q "insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
                values ('$CASHIER','$BRANCH','cashier','$ADMIN')
                on conflict do nothing returning id;")
if [ -n "$ASSIGNMENT" ]; then
  echo "created a temporary cashier assignment ($ASSIGNMENT)"
else
  echo "reusing the cashier's existing assignment -- it will not be removed"
fi

# No branch fee for this run, so the arithmetic below is the sale itself.
HAD_SETTINGS=$(q "select count(*) from public.branch_pos_settings where branch_id='$BRANCH';")
q "insert into public.branch_pos_settings (branch_id, fees) values ('$BRANCH','[]'::jsonb)
   on conflict (branch_id) do update set fees = '[]'::jsonb;" > /dev/null

cleanup() {
  q "delete from public.pos_sale_items where sale_id in (select id from public.pos_sales where branch_id='$BRANCH');
     delete from public.pos_sales where branch_id='$BRANCH';
     delete from public.pos_inventory_movements where product_id='$PRODUCT';
     delete from public.pos_branch_inventory where product_id='$PRODUCT';
     delete from public.pos_branch_products where product_id='$PRODUCT';
     delete from public.pos_products where id='$PRODUCT';
     delete from public.audit_logs where table_name in ('pos_sales','pos_branch_inventory');" > /dev/null
  if [ "$HAD_SETTINGS" = "0" ]; then
    q "delete from public.branch_pos_settings where branch_id='$BRANCH';" > /dev/null
  fi
  # Only ever the row this script created.
  [ -n "$ASSIGNMENT" ] && q "delete from public.pos_branch_assignments where id='$ASSIGNMENT';" > /dev/null
  # The minted till user, and everything hanging off it. Ordered so no foreign
  # key blocks the delete.
  if [ -n "$CASHIER" ]; then
    q "delete from public.pos_branch_assignments where profile_id='$CASHIER';
       delete from public.pos_audit_events where actor_id='$CASHIER';
       delete from public.profiles where id='$CASHIER';
       delete from public.employees where id='$CASHIER_EMPLOYEE';
       delete from auth.users where id='$CASHIER';" > /dev/null
  fi
}
trap cleanup EXIT

checkout() { # key, quantity, tendered
  "${DB[@]}" -c "
    select set_config('request.jwt.claims', '{\"sub\":\"$CASHIER\",\"role\":\"authenticated\"}', false);
    set role authenticated;
    select public.checkout_pos_sale(
      '$BRANCH',
      jsonb_build_array(jsonb_build_object('product_id','$PRODUCT','quantity',$2)),
      'cash', '$1', null, $3);" 2>&1
}

# ------------------------------------------------- 1. same key, concurrently
echo
echo "=== 1. the same checkout key, sent twice at once ==="
q "select public.receive_pos_stock('$BRANCH','$PRODUCT',100,50.00,null);" > /dev/null 2>&1 || {
  # receive_pos_stock is admin-only; run it as the admin.
  "${DB[@]}" -c "
    select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false);
    set role authenticated;
    select public.receive_pos_stock('$BRANCH','$PRODUCT',100,50.00,null);" > /dev/null 2>&1
}
BEFORE=$(q "select quantity_on_hand from public.pos_branch_inventory where product_id='$PRODUCT';")

KEY=$(q "select gen_random_uuid();")
for i in 1 2 3 4 5; do ( checkout "$KEY" 2 1000 > /dev/null 2>&1 ) & done
wait

SALES=$(q "select count(*) from public.pos_sales where branch_id='$BRANCH';")
ITEMS=$(q "select count(*) from public.pos_sale_items;")
MOVES=$(q "select count(*) from public.pos_inventory_movements where product_id='$PRODUCT' and movement_type='sale';")
AFTER=$(q "select quantity_on_hand from public.pos_branch_inventory where product_id='$PRODUCT';")

[ "$SALES" = "1" ] && pass "1a five simultaneous sends of one key produced 1 sale" \
                   || fail "1a produced $SALES sales -- the customer was charged more than once"
[ "$ITEMS" = "1" ] && pass "1b exactly one sale line" || fail "1b $ITEMS sale lines, expected 1"
[ "$MOVES" = "1" ] && pass "1c exactly one sale movement" || fail "1c $MOVES sale movements, expected 1"
[ "$AFTER" = "$((BEFORE - 2))" ] && pass "1d stock fell once: $BEFORE -> $AFTER" \
                                 || fail "1d stock is $AFTER, expected $((BEFORE - 2))"

# ------------------------------------------------------- 2. the last unit
echo
echo "=== 2. five tills racing for the last unit ==="

# Drive the balance down to exactly 1.
CUR=$(q "select quantity_on_hand from public.pos_branch_inventory where product_id='$PRODUCT';")
"${DB[@]}" -c "
  select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false);
  set role authenticated;
  select public.adjust_pos_stock('$BRANCH','$PRODUCT', $((1 - CUR)), 'recount', 'concurrency fixture');" > /dev/null 2>&1

CUR=$(q "select quantity_on_hand from public.pos_branch_inventory where product_id='$PRODUCT';")
[ "$CUR" = "1" ] || { echo "FAIL  fixture: could not reach a balance of 1 (got $CUR)"; exit 1; }

SALES_BEFORE=$(q "select count(*) from public.pos_sales where branch_id='$BRANCH';")
for i in 1 2 3 4 5; do
  ( KEY=$("${DB[@]}" -c "select gen_random_uuid();"); checkout "$KEY" 1 1000 > /dev/null 2>&1 ) &
done
wait

SALES_AFTER=$(q "select count(*) from public.pos_sales where branch_id='$BRANCH';")
FINAL=$(q "select quantity_on_hand from public.pos_branch_inventory where product_id='$PRODUCT';")
WON=$((SALES_AFTER - SALES_BEFORE))

[ "$WON" = "1" ] && pass "2a exactly one of five tills sold the last unit" \
                 || fail "2a $WON tills sold the last unit"
[ "$FINAL" = "0" ] && pass "2b the balance landed on 0" || fail "2b the balance is $FINAL, expected 0"

NEGATIVE=$(q "select count(*) from public.pos_inventory_movements
              where product_id='$PRODUCT' and stock_after < 0;")
[ "$NEGATIVE" = "0" ] && pass "2c stock never went negative at any point in the ledger" \
                      || fail "2c $NEGATIVE movements left a negative balance"

# Only the winner may have written records.
ORPHANS=$(q "select count(*) from public.pos_inventory_movements m
             where m.product_id='$PRODUCT' and m.movement_type='sale'
               and not exists (select 1 from public.pos_sales s where s.id = m.source_id);")
[ "$ORPHANS" = "0" ] && pass "2d every sale movement belongs to a committed sale" \
                     || fail "2d $ORPHANS sale movements have no sale"

LINES=$(q "select count(*) from public.pos_sale_items i
           join public.pos_sales s on s.id = i.sale_id where s.branch_id='$BRANCH';")
[ "$LINES" = "$SALES_AFTER" ] && pass "2e the losing tills wrote no sale lines" \
                             || fail "2e $LINES lines for $SALES_AFTER sales"

# ------------------------------------------------ 3. the ledger reconstructs
echo
echo "=== 3. the ledger still reconstructs the balance ==="

BROKEN=$(q "select count(*) from public.pos_inventory_movements
            where product_id='$PRODUCT' and stock_after <> stock_before + quantity_change;")
[ "$BROKEN" = "0" ] && pass "3a every movement satisfies the stock equation" \
                    || fail "3a $BROKEN movements break the stock equation"

SUM=$(q "select coalesce(sum(quantity_change),0) from public.pos_inventory_movements where product_id='$PRODUCT';")
[ "$SUM" = "$FINAL" ] && pass "3b the movements sum to the balance: $SUM" \
                      || fail "3b movements sum to $SUM but the balance is $FINAL"

CHAIN=$(q "with ordered as (
             select stock_before, lag(stock_after) over (order by created_at, id) as prev
             from public.pos_inventory_movements where product_id='$PRODUCT')
           select count(*) from ordered where prev is not null and prev <> stock_before;")
[ "$CHAIN" = "0" ] && pass "3c each movement continues from the previous balance" \
                   || fail "3c $CHAIN movements do not continue the chain"

# Selling must never have moved the branch average.
AVG=$(q "select average_unit_cost from public.pos_branch_inventory where product_id='$PRODUCT';")
[ "$AVG" = "50.00" ] && pass "3d selling left the branch average at $AVG" \
                     || fail "3d the branch average is $AVG, expected 50.00"

echo
if [ "$FAILED" = "0" ]; then
  echo "==== all checkout concurrency checks passed ===="
  exit 0
fi
echo "==== checkout concurrency checks FAILED ===="
exit 1
