#!/usr/bin/env bash
# Two Administrators granting the same person POS access at the same branch, at
# the same moment. Exactly one must win.
#
# The screen now hides "Grant again" when an active assignment exists, but that
# is a courtesy: two admins on two laptops never see each other's screen. The
# invariant that actually holds is the partial unique index
#
#   pos_branch_assignments_active_unique  UNIQUE (profile_id, branch_id)
#                                         WHERE status = 'active'
#
# and a single-session test cannot prove it holds under a race. This one opens
# two real connections and starts both inserts before either commits.
#
# Leaves no residue: everything it creates is removed at the end, and the script
# verifies that.

set -uo pipefail

DB="docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres -X -q -A -t"
FAIL=0

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAIL=1; }

echo "=== fixture ==="

read -r ADMIN WORKER BRANCH <<<"$($DB -c "
  select
    (select id from public.profiles where role='admin' and status='active' limit 1),
    (select p.id from public.profiles p
      join public.employees e on e.id = p.employee_id
      where p.role='employee' and p.status='active'
        and public.is_eligible_for_system_role(p.id,'pos','manager')
      limit 1),
    (select id from public.branches where is_active order by name limit 1);
" | tr '|' ' ')"

if [ -z "${WORKER:-}" ] || [ "$WORKER" = "" ]; then
  echo "SKIP: no POS-manager-eligible employee in this database"
  exit 0
fi

echo "  admin=$ADMIN"
echo "  worker=$WORKER"
echo "  branch=$BRANCH"

# Start clean for this pair.
$DB -c "delete from public.pos_branch_assignments
        where profile_id='$WORKER' and branch_id='$BRANCH';" >/dev/null

echo ""
echo "=== two concurrent grants ==="

# Both transactions open, both insert, then both commit. Whichever commits
# second must hit the unique index rather than producing a duplicate.
grant_attempt() {
  local tag="$1"
  $DB -c "
    begin;
    select pg_sleep(0.2);
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values ('$WORKER', '$BRANCH', 'manager', '$ADMIN');
    commit;
  " >"/tmp/grant_$tag.out" 2>&1
  echo "$?" >"/tmp/grant_$tag.code"
}

grant_attempt a &
grant_attempt b &
wait

CODE_A=$(cat /tmp/grant_a.code)
CODE_B=$(cat /tmp/grant_b.code)
WINNERS=0
[ "$CODE_A" = "0" ] && WINNERS=$((WINNERS + 1))
[ "$CODE_B" = "0" ] && WINNERS=$((WINNERS + 1))

echo "  attempt a exit=$CODE_A"
echo "  attempt b exit=$CODE_B"

ACTIVE=$($DB -c "select count(*) from public.pos_branch_assignments
                 where profile_id='$WORKER' and branch_id='$BRANCH' and status='active';")

if [ "$ACTIVE" = "1" ]; then
  pass "1a exactly one active assignment survived two concurrent grants"
else
  fail "1a $ACTIVE active assignments after a concurrent double grant"
fi

if [ "$WINNERS" = "1" ]; then
  pass "1b exactly one grant reported success"
else
  # Both succeeding would mean the index is missing; both failing would mean
  # something unrelated broke, and either is worth failing the run for.
  fail "1b $WINNERS of 2 concurrent grants reported success"
  echo "--- a ---"; cat /tmp/grant_a.out
  echo "--- b ---"; cat /tmp/grant_b.out
fi

LOSER_MSG=$(grep -ho "pos_branch_assignments_active_unique" /tmp/grant_a.out /tmp/grant_b.out | head -1)
if [ -n "$LOSER_MSG" ]; then
  pass "1c the loser was stopped by the unique index, not by chance"
else
  fail "1c the losing grant did not cite pos_branch_assignments_active_unique"
fi

echo ""
echo "=== cleanup ==="
$DB -c "delete from public.pos_branch_assignments
        where profile_id='$WORKER' and branch_id='$BRANCH';" >/dev/null
LEFT=$($DB -c "select count(*) from public.pos_branch_assignments
               where profile_id='$WORKER' and branch_id='$BRANCH';")
if [ "$LEFT" = "0" ]; then
  pass "2a no residue left behind"
else
  fail "2a $LEFT rows left behind"
fi

rm -f /tmp/grant_a.out /tmp/grant_b.out /tmp/grant_a.code /tmp/grant_b.code

echo ""
if [ "$FAIL" = "0" ]; then
  echo "==== all POS grant concurrency checks passed ===="
else
  echo "==== POS grant concurrency FAILED ===="
  exit 1
fi
