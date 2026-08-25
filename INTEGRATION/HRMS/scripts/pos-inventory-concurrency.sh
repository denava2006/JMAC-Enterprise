#!/usr/bin/env bash
# Two-session inventory concurrency test.
#
# The single-session contract test (supabase/tests/pos_inventory_rls.sql) cannot
# show a lost update: everything inside one transaction sees its own writes. This
# runs genuinely concurrent psql sessions against the same branch/product and
# checks that every one of them landed.
#
# It writes real, committed rows -- a lost update is only observable after a
# commit -- and removes them again at the end.
#
#   bash scripts/pos-inventory-concurrency.sh
#
# Exits non-zero on any failure.

set -uo pipefail

DB=(docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres -tAq)
RECEIPTS=5
PER_RECEIPT=10

q() { "${DB[@]}" -c "$1"; }

fail() { echo "FAIL  $1"; FAILED=1; }
pass() { echo "PASS  $1"; }
FAILED=0

echo "=== setting up committed fixtures ==="
TAG="conc$(date +%s)"
ADMIN=$(q "select id from public.profiles where role='admin' and status='active' limit 1;")
BRANCH=$(q "select id from public.branches where is_active order by name limit 1;")
CATEGORY=$(q "select id from public.pos_product_categories where normalized_name='general';")

if [ -z "$ADMIN" ] || [ -z "$BRANCH" ] || [ -z "$CATEGORY" ]; then
  echo "FAIL  fixture: need an active admin, an active branch and the General category"
  exit 1
fi

PRODUCT=$(q "insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
             values ('ZZ Concurrency $TAG', '$CATEGORY', 10, 5, 'active') returning id;")
q "insert into public.pos_branch_products (branch_id, product_id) values ('$BRANCH', '$PRODUCT');" > /dev/null

START=$(q "select quantity_on_hand from public.pos_branch_inventory
           where branch_id='$BRANCH' and product_id='$PRODUCT';")
echo "product $PRODUCT at branch $BRANCH, starting quantity ${START:-<none>}"

if [ "$START" != "0" ]; then
  fail "the auto-created balance was '$START', expected 0"
fi

cleanup() {
  q "delete from public.pos_inventory_movements where product_id='$PRODUCT';
     delete from public.pos_branch_inventory where product_id='$PRODUCT';
     delete from public.pos_branch_products where product_id='$PRODUCT';
     delete from public.pos_products where id='$PRODUCT';
     delete from public.audit_logs where record_id='$PRODUCT';" > /dev/null
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1. blocking
#
# Session A locks the row and holds it. Session B must wait for A's commit
# rather than reading the pre-A quantity.
echo
echo "=== 1. a second session waits for the first ==="

(
  "${DB[@]}" -c "
    select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false);
    set role authenticated;
    begin;
    select public.receive_pos_stock('$BRANCH','$PRODUCT',$PER_RECEIPT,40.00,'holder');
    select pg_sleep(3);
    commit;" > /dev/null 2>&1
) &
HOLDER=$!

sleep 1
B_START=$(date +%s%N)
"${DB[@]}" -c "
  select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false);
  set role authenticated;
  select public.receive_pos_stock('$BRANCH','$PRODUCT',$PER_RECEIPT,60.00,'waiter');" > /dev/null 2>&1
B_END=$(date +%s%N)
wait $HOLDER
WAITED_MS=$(( (B_END - B_START) / 1000000 ))

if [ "$WAITED_MS" -ge 1500 ]; then
  pass "1a the second session blocked for ${WAITED_MS}ms until the first committed"
else
  fail "1a the second session returned in ${WAITED_MS}ms -- it did not wait for the row lock"
fi

AFTER_TWO=$(q "select quantity_on_hand from public.pos_branch_inventory
               where branch_id='$BRANCH' and product_id='$PRODUCT';")
if [ "$AFTER_TWO" = "$((PER_RECEIPT * 2))" ]; then
  pass "1b both receipts landed: quantity is $AFTER_TWO"
else
  fail "1b quantity is $AFTER_TWO, expected $((PER_RECEIPT * 2)) -- an update was lost"
fi

# The waiter received at 60 on top of 10 @ 40, so the average must be 50.
AVG=$(q "select average_unit_cost from public.pos_branch_inventory
         where branch_id='$BRANCH' and product_id='$PRODUCT';")
if [ "$AVG" = "50.00" ]; then
  pass "1c the second session averaged against the FIRST session's result: $AVG"
else
  fail "1c average is $AVG, expected 50.00 -- the second session used a stale quantity"
fi

# ------------------------------------------------------- 2. parallel receipts
echo
echo "=== 2. $RECEIPTS simultaneous receipts ==="

BEFORE=$(q "select quantity_on_hand from public.pos_branch_inventory
            where branch_id='$BRANCH' and product_id='$PRODUCT';")
MOVES_BEFORE=$(q "select count(*) from public.pos_inventory_movements where product_id='$PRODUCT';")

for i in $(seq 1 $RECEIPTS); do
  (
    "${DB[@]}" -c "
      select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false);
      set role authenticated;
      select public.receive_pos_stock('$BRANCH','$PRODUCT',$PER_RECEIPT,40.00,'parallel $i');" > /dev/null 2>&1
  ) &
done
wait

AFTER=$(q "select quantity_on_hand from public.pos_branch_inventory
           where branch_id='$BRANCH' and product_id='$PRODUCT';")
MOVES_AFTER=$(q "select count(*) from public.pos_inventory_movements where product_id='$PRODUCT';")
EXPECTED=$((BEFORE + RECEIPTS * PER_RECEIPT))
EXPECTED_MOVES=$((MOVES_BEFORE + RECEIPTS))

if [ "$AFTER" = "$EXPECTED" ]; then
  pass "2a $BEFORE + ${RECEIPTS}x${PER_RECEIPT} = $AFTER, no lost updates"
else
  fail "2a quantity is $AFTER, expected $EXPECTED -- $(( (EXPECTED - AFTER) / PER_RECEIPT )) update(s) lost"
fi

if [ "$MOVES_AFTER" = "$EXPECTED_MOVES" ]; then
  pass "2b exactly one movement per receipt: $MOVES_AFTER"
else
  fail "2b $MOVES_AFTER movements, expected $EXPECTED_MOVES"
fi

# ------------------------------------------------- 3. the ledger reconstructs
#
# The strongest check: replaying every movement in order must land on the
# balance. If a concurrent write had slipped past the lock, the chain would
# break even if the total happened to look right.
echo
echo "=== 3. the ledger reconstructs the balance ==="

BROKEN=$(q "select count(*) from public.pos_inventory_movements
            where product_id='$PRODUCT'
              and stock_after <> stock_before + quantity_change;")
if [ "$BROKEN" = "0" ]; then
  pass "3a every movement satisfies stock_after = stock_before + quantity_change"
else
  fail "3a $BROKEN movements break the stock equation"
fi

SUM=$(q "select coalesce(sum(quantity_change),0) from public.pos_inventory_movements
         where product_id='$PRODUCT';")
if [ "$SUM" = "$AFTER" ]; then
  pass "3b the movements sum to the balance: $SUM"
else
  fail "3b movements sum to $SUM but the balance is $AFTER"
fi

# Ordering by created_at is WRONG here, and used to fail this check at random.
# created_at defaults to now(), which is fixed at BEGIN, while the ledger's real
# sequence is decided by who acquires the row lock. A session can start its
# transaction first and take the lock last -- reproduced deliberately on
# 2026-08-26 -- so created_at order and ledger order legitimately diverge, and
# the chain looks broken when it is not.
#
# The invariant is order-independent: the movements form ONE unbroken path.
# Every movement's stock_before must be some other movement's stock_after,
# except exactly one -- the first. Anything else is a genuine interleaved read.
CHAIN=$(q "with m as (
             select id, stock_before, stock_after
             from public.pos_inventory_movements where product_id='$PRODUCT')
           select count(*) from m
           where not exists (select 1 from m prev where prev.stock_after = m.stock_before
                                                   and prev.id <> m.id)
             and m.stock_before <> 0;")
if [ "$CHAIN" = "0" ]; then
  pass "3c the movements form one unbroken chain -- no interleaved read"
else
  fail "3c $CHAIN movement(s) start from a balance no other movement produced"
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "==== all inventory concurrency checks passed ===="
  exit 0
fi
echo "==== inventory concurrency checks FAILED ===="
exit 1
